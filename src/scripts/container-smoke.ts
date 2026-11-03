import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { GlobalFonts, createCanvas } from "@napi-rs/canvas";
import Database from "better-sqlite3";
import nodejieba from "nodejieba";

export interface ContainerSmokeResult {
  platform: string;
  sqlite: true;
  nodejieba: string[];
  canvasPngBytes: number;
}

export function runContainerSmoke(): ContainerSmokeResult {
  const fontPath = fileURLToPath(
    new URL("../../assets/fonts/SourceHanSans-VF.ttf", import.meta.url),
  );
  accessSync(fontPath, constants.R_OK);
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE smoke (value TEXT NOT NULL) STRICT");
    database.prepare("INSERT INTO smoke (value) VALUES (?)").run("ok");
    const result = database.prepare("SELECT value FROM smoke").pluck().get();
    if (result !== "ok") throw new Error("SQLite smoke query returned an unexpected value");
  } finally {
    database.close();
  }
  nodejieba.load();
  const segments = nodejieba.cut("南京市长江大桥");
  if (!segments.includes("南京市") || !segments.includes("长江大桥"))
    throw new Error(`nodejieba smoke segmentation failed: ${segments.join("/")}`);
  const fontAlias = "NyarbotContainerSmokeCJK";
  if (!GlobalFonts.has(fontAlias) && !GlobalFonts.registerFromPath(fontPath, fontAlias))
    throw new Error("Canvas smoke font registration failed");
  const canvas = createCanvas(160, 80);
  const context = canvas.getContext("2d");
  context.font = `32px ${fontAlias}`;
  context.fillText("中文词云", 4, 45);
  const png = canvas.toBuffer("image/png");
  if (png.length < 200 || png.subarray(1, 4).toString() !== "PNG")
    throw new Error("Canvas smoke render did not produce a valid PNG");
  return {
    platform: `${process.platform}/${process.arch}`,
    sqlite: true,
    nodejieba: segments,
    canvasPngBytes: png.length,
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url)
  console.log(JSON.stringify(runContainerSmoke()));
