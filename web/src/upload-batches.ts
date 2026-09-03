export const MAX_UPLOAD_BATCH_FILES = 512;
export const MAX_UPLOAD_BATCH_BYTES = 16 * 1024 * 1024 * 1024;
export const MAX_UPLOAD_DECLARATION_BYTES = 14 * 1024;

const DECLARATION_ENVELOPE_RESERVE_BYTES = 1_024;
const encoder = new TextEncoder();

export interface UploadBatchCandidate {
  fileId: string;
  relativePath: string;
  size: number;
}

export function partitionUploadBatches<T extends UploadBatchCandidate>(entries: T[]): T[][] {
  const batches: T[][] = [];
  let batch: T[] = [];
  let batchBytes = 0;
  let declarationBytes = DECLARATION_ENVELOPE_RESERVE_BYTES;

  for (const entry of entries) {
    const entryDeclarationBytes = uploadFileSpecBytes(entry);
    const exceedsCurrentBatch =
      batch.length >= MAX_UPLOAD_BATCH_FILES ||
      batchBytes + entry.size > MAX_UPLOAD_BATCH_BYTES ||
      declarationBytes + entryDeclarationBytes > MAX_UPLOAD_DECLARATION_BYTES;
    if (batch.length > 0 && exceedsCurrentBatch) {
      batches.push(batch);
      batch = [];
      batchBytes = 0;
      declarationBytes = DECLARATION_ENVELOPE_RESERVE_BYTES;
    }
    if (declarationBytes + entryDeclarationBytes > MAX_UPLOAD_DECLARATION_BYTES) {
      throw new Error("A selected file path is too long for the secure upload declaration");
    }
    batch.push(entry);
    batchBytes += entry.size;
    declarationBytes += entryDeclarationBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

export function uploadDeclarationBytes(entries: UploadBatchCandidate[]): number {
  const fileBytes = entries.reduce((total, entry) => total + uploadFileSpecBytes(entry), 0);
  return DECLARATION_ENVELOPE_RESERVE_BYTES + fileBytes;
}

function uploadFileSpecBytes(entry: UploadBatchCandidate): number {
  return (
    encoder.encode(
      JSON.stringify({ fileId: entry.fileId, relativePath: entry.relativePath, size: entry.size }),
    ).byteLength + 1
  );
}
