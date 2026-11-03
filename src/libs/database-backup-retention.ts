const RETAIN_SUCCESSFUL_ARCHIVES = 7;

export interface BackupArchiveEntry {
  name: string;
  mtimeMs: number;
}

export function selectArchiveNamesToDelete(
  archives: BackupArchiveEntry[],
  successfulArchiveNames: string[],
): string[] {
  const recorded = new Set(successfulArchiveNames);
  const retainedSuccessful = new Set(successfulArchiveNames.slice(0, RETAIN_SUCCESSFUL_ARCHIVES));
  const latestFailed = archives
    .filter((archive) => !recorded.has(archive.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]?.name;
  return archives
    .filter((archive) => !retainedSuccessful.has(archive.name) && archive.name !== latestFailed)
    .map((archive) => archive.name);
}
