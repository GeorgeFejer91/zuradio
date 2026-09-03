export interface UploadManifestEntry {
  batchId: string;
  ordinal: number;
  sha256: string;
  relativePath: string;
  sizeBytes: number;
  modifiedUnix: number;
  sourcePath: string;
}

export interface LoadedUploadManifest {
  batchId: string;
  plannedEntries: UploadManifestEntry[];
  pendingEntries: UploadManifestEntry[];
  confirmed: Set<string>;
}

export function loadUploadManifest(
  manifestPath: string,
  sourceRoot: string,
  ledgerPath: string,
): LoadedUploadManifest;

export function appendUploadLedger(ledgerPath: string, entries: UploadManifestEntry[]): void;

export function loadUploadLedger(ledgerPath: string): Set<string>;
