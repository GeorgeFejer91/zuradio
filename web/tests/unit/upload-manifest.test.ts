import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  appendUploadLedger,
  loadUploadLedger,
  loadUploadManifest,
} from "../../scripts/upload-manifest.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("upload manifest and acknowledgement ledger", () => {
  test("loads a quoted CSV batch and skips a durably acknowledged hash", () => {
    const directory = temporaryDirectory();
    const sourceRoot = path.join(directory, "source, music");
    const sourcePath = path.join(sourceRoot, "Artist", "Album", "01 - Song.wav");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "manifest fixture");
    const metadata = fs.statSync(sourcePath);
    const sha256 = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    const manifestPath = path.join(directory, "batch.csv");
    const ledgerPath = path.join(directory, "acks.jsonl");
    fs.writeFileSync(
      manifestPath,
      [
        "batchId,ordinal,sha256,relativePath,filename,extension,sizeBytes,modifiedUnix,sourcePath",
        [
          "batch-001",
          "1",
          sha256,
          "Artist/Album/01 - Song.wav",
          "01 - Song.wav",
          ".wav",
          String(metadata.size),
          String(metadata.mtimeMs / 1_000),
          sourcePath,
        ].map(csv).join(","),
      ].join("\n"),
    );

    const first = loadUploadManifest(manifestPath, sourceRoot, ledgerPath);
    expect(first.batchId).toBe("batch-001");
    expect(first.pendingEntries).toHaveLength(1);
    expect(first.pendingEntries[0]).toMatchObject({
      ordinal: 1,
      sha256,
      relativePath: "Artist/Album/01 - Song.wav",
      sizeBytes: metadata.size,
      sourcePath,
    });

    appendUploadLedger(ledgerPath, first.pendingEntries);
    const ledger = fs.readFileSync(ledgerPath, "utf8");
    expect(ledger).toContain('"event":"catalogued"');
    expect(ledger).not.toContain(sourceRoot);
    expect(loadUploadLedger(ledgerPath)).toEqual(new Set([sha256]));

    const resumed = loadUploadManifest(manifestPath, sourceRoot, ledgerPath);
    expect(resumed.plannedEntries).toHaveLength(1);
    expect(resumed.pendingEntries).toHaveLength(0);
  });

  test("rejects a source that changed after catalogue creation", () => {
    const directory = temporaryDirectory();
    const sourcePath = path.join(directory, "Song.wav");
    fs.writeFileSync(sourcePath, "changed source");
    const metadata = fs.statSync(sourcePath);
    const manifestPath = path.join(directory, "batch.json");
    const ledgerPath = path.join(directory, "acks.jsonl");
    fs.writeFileSync(manifestPath, JSON.stringify({
      batchId: "batch-002",
      files: [{
        ordinal: 1,
        sha256: "a".repeat(64),
        relativePath: "Song.wav",
        sizeBytes: metadata.size + 1,
        modifiedUnix: metadata.mtimeMs / 1_000,
      }],
    }));

    expect(() => loadUploadManifest(manifestPath, directory, ledgerPath)).toThrow(
      "byte size changed after catalogue creation",
    );
  });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zuradio-manifest-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function csv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
