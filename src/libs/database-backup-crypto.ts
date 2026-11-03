import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  type CipherGCM,
  type DecipherGCM,
  randomUUID,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm } from "node:fs/promises";
import { Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";

const MAGIC = Buffer.from("NYARBKP\0", "ascii");
const VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.length + 1 + 4 * 3 + SALT_BYTES + IV_BYTES;
const KEY_BYTES = 32;
const MAX_RESTORED_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_KDF = {
  cost: 32_768,
  blockSize: 8,
  parallelization: 1,
  maxmem: 64 * 1024 * 1024,
} as const;

export interface BackupKdfOptions {
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  maxmem?: number;
}

function createHeader(options: Required<Omit<BackupKdfOptions, "maxmem">>): Buffer {
  const header = Buffer.alloc(HEADER_BYTES);
  MAGIC.copy(header);
  header.writeUInt8(VERSION, MAGIC.length);
  let offset = MAGIC.length + 1;
  header.writeUInt32BE(options.cost, offset);
  offset += 4;
  header.writeUInt32BE(options.blockSize, offset);
  offset += 4;
  header.writeUInt32BE(options.parallelization, offset);
  offset += 4;
  randomBytes(SALT_BYTES).copy(header, offset);
  randomBytes(IV_BYTES).copy(header, offset + SALT_BYTES);
  return header;
}

function parseHeader(header: Buffer): {
  cost: number;
  blockSize: number;
  parallelization: number;
  salt: Buffer;
  iv: Buffer;
} {
  if (header.length !== HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error("Not a nyarbot encrypted SQLite backup");
  }
  const version = header.readUInt8(MAGIC.length);
  if (version !== VERSION) throw new Error(`Unsupported backup format version: ${version}`);
  let offset = MAGIC.length + 1;
  const cost = header.readUInt32BE(offset);
  offset += 4;
  const blockSize = header.readUInt32BE(offset);
  offset += 4;
  const parallelization = header.readUInt32BE(offset);
  offset += 4;
  const salt = header.subarray(offset, offset + SALT_BYTES);
  const iv = header.subarray(offset + SALT_BYTES, HEADER_BYTES);
  if (
    cost < 2 ||
    (cost & (cost - 1)) !== 0 ||
    cost > DEFAULT_KDF.cost ||
    blockSize < 1 ||
    blockSize > DEFAULT_KDF.blockSize ||
    parallelization < 1 ||
    parallelization > DEFAULT_KDF.parallelization
  ) {
    throw new Error("Backup contains unsafe or invalid scrypt parameters");
  }
  return { cost, blockSize, parallelization, salt, iv };
}

async function deriveKey(
  passphrase: string,
  salt: Buffer,
  options: Required<BackupKdfOptions>,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      passphrase,
      salt,
      KEY_BYTES,
      { N: options.cost, r: options.blockSize, p: options.parallelization, maxmem: options.maxmem },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

class EncryptTransform extends Transform {
  constructor(private readonly cipher: CipherGCM) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      callback(null, this.cipher.update(chunk));
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      callback(null, Buffer.concat([this.cipher.final(), this.cipher.getAuthTag()]));
    } catch (err) {
      callback(err as Error);
    }
  }
}

class DecryptTransform extends Transform {
  private trailing = Buffer.alloc(0);

  constructor(private readonly decipher: DecipherGCM) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      const combined = Buffer.concat([this.trailing, chunk]);
      if (combined.length <= AUTH_TAG_BYTES) {
        this.trailing = combined;
        callback();
        return;
      }
      const encryptedEnd = combined.length - AUTH_TAG_BYTES;
      this.trailing = combined.subarray(encryptedEnd);
      callback(null, this.decipher.update(combined.subarray(0, encryptedEnd)));
    } catch (err) {
      callback(err as Error);
    }
  }

  override _flush(callback: TransformCallback): void {
    try {
      if (this.trailing.length !== AUTH_TAG_BYTES)
        throw new Error("Truncated backup authentication tag");
      this.decipher.setAuthTag(this.trailing);
      callback(null, this.decipher.final());
    } catch (err) {
      callback(err as Error);
    }
  }
}

class ByteLimitTransform extends Transform {
  private bytes = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.bytes += chunk.length;
    if (this.bytes > MAX_RESTORED_BYTES) {
      callback(new Error(`Restored SQLite backup exceeds ${MAX_RESTORED_BYTES} bytes`));
      return;
    }
    callback(null, chunk);
  }
}

export async function encryptSqliteBackup(
  sqlitePath: string,
  archivePath: string,
  passphrase: string,
  kdf: BackupKdfOptions = {},
): Promise<void> {
  const options = { ...DEFAULT_KDF, ...kdf };
  const header = createHeader(options);
  const { salt, iv } = parseHeader(header);
  const key = await deriveKey(passphrase, salt, options);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const reserved = await open(archivePath, "wx", 0o600);
  try {
    await reserved.writeFile(header);
    await reserved.close();
    await pipeline(
      createReadStream(sqlitePath),
      createGzip({ level: 9 }),
      new EncryptTransform(cipher),
      createWriteStream(archivePath, { flags: "a" }),
    );
  } catch (err) {
    await reserved.close().catch(() => void 0);
    await rm(archivePath, { force: true }).catch(() => void 0);
    throw err;
  }
}

export async function decryptSqliteBackup(
  archivePath: string,
  sqlitePath: string,
  passphrase: string,
  options: { overwrite?: boolean; maxmem?: number } = {},
): Promise<void> {
  const input = await open(archivePath, "r");
  const header = Buffer.alloc(HEADER_BYTES);
  try {
    const { bytesRead } = await input.read(header, 0, HEADER_BYTES, 0);
    if (bytesRead !== HEADER_BYTES) throw new Error("Truncated backup header");
  } finally {
    await input.close();
  }
  const parsed = parseHeader(header);
  const key = await deriveKey(passphrase, parsed.salt, {
    cost: parsed.cost,
    blockSize: parsed.blockSize,
    parallelization: parsed.parallelization,
    maxmem:
      options.maxmem ?? Math.max(DEFAULT_KDF.maxmem, 128 * parsed.cost * parsed.blockSize + 1024),
  });
  const decipher = createDecipheriv("aes-256-gcm", key, parsed.iv, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(header);
  const compressedPath = `${sqlitePath}.compressed-${randomUUID()}.tmp`;
  try {
    await pipeline(
      createReadStream(archivePath, { start: HEADER_BYTES }),
      new DecryptTransform(decipher),
      createWriteStream(compressedPath, { flags: "wx", mode: 0o600 }),
    );
  } catch (err) {
    await rm(compressedPath, { force: true }).catch(() => void 0);
    throw err;
  }
  try {
    await pipeline(
      createReadStream(compressedPath),
      createGunzip(),
      new ByteLimitTransform(),
      createWriteStream(sqlitePath, { flags: options.overwrite ? "w" : "wx", mode: 0o600 }),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      await rm(sqlitePath, { force: true }).catch(() => void 0);
    }
    throw err;
  } finally {
    await rm(compressedPath, { force: true }).catch(() => void 0);
  }
}
