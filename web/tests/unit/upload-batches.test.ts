import { describe, expect, it } from "vitest";

import {
  MAX_UPLOAD_BATCH_BYTES,
  MAX_UPLOAD_BATCH_FILES,
  MAX_UPLOAD_DECLARATION_BYTES,
  partitionUploadBatches,
  uploadDeclarationBytes,
} from "../../src/upload-batches";

interface Candidate {
  fileId: string;
  relativePath: string;
  size: number;
  index: number;
}

describe("upload batch partitioning", () => {
  it("partitions 9,088 files without changing their order or transaction bounds", () => {
    const entries = Array.from({ length: 9_088 }, (_, index) => candidate(index, 1_048_576));

    const batches = partitionUploadBatches(entries);

    expect(batches.length).toBeGreaterThanOrEqual(18);
    expect(batches.flat().map((entry) => entry.index)).toEqual(entries.map((entry) => entry.index));
    for (const batch of batches) {
      expect(batch.length).toBeLessThanOrEqual(MAX_UPLOAD_BATCH_FILES);
      expect(batch.reduce((total, entry) => total + entry.size, 0)).toBeLessThanOrEqual(
        MAX_UPLOAD_BATCH_BYTES,
      );
      expect(uploadDeclarationBytes(batch)).toBeLessThanOrEqual(MAX_UPLOAD_DECLARATION_BYTES);
    }
  });

  it("starts a new transaction before the 16 GiB receiver limit", () => {
    const entries = Array.from({ length: 33 }, (_, index) => candidate(index, 512 * 1024 * 1024));

    const batches = partitionUploadBatches(entries);

    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(32);
    expect(batches[1]).toHaveLength(1);
  });

  it("keeps long-path declarations below the WebRTC control-frame limit", () => {
    const entries = Array.from({ length: 100 }, (_, index) => ({
      ...candidate(index, 1),
      relativePath: `${"Album/".repeat(70)}Track-${index}.flac`,
    }));

    const batches = partitionUploadBatches(entries);

    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((batch) => uploadDeclarationBytes(batch) <= MAX_UPLOAD_DECLARATION_BYTES)).toBe(true);
  });
});

function candidate(index: number, size: number): Candidate {
  return {
    fileId: `file-00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    relativePath: `Artist/Album/Track ${String(index).padStart(5, "0")}.flac`,
    size,
    index,
  };
}
