import fs from "node:fs";
import path from "node:path";

const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

export function loadUploadManifest(manifestPath, sourceRoot, ledgerPath) {
  const manifest = parseManifest(fs.readFileSync(manifestPath, "utf8"));
  const root = path.resolve(sourceRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error("the manifest source root is unavailable");
  }
  const confirmed = loadUploadLedger(ledgerPath);
  const seen = new Set();
  const entries = manifest.rows.map((row, index) => normalizeEntry(row, index, manifest.batchId, root));
  for (const entry of entries) {
    if (seen.has(entry.sha256)) throw new Error(`manifest row ${entry.ordinal} repeats a SHA-256 digest`);
    seen.add(entry.sha256);
  }
  return {
    batchId: manifest.batchId,
    plannedEntries: entries,
    pendingEntries: entries.filter((entry) => !confirmed.has(entry.sha256)),
    confirmed,
  };
}

export function appendUploadLedger(ledgerPath, entries) {
  if (entries.length === 0) return;
  const parent = path.dirname(ledgerPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const lines = entries
    .map((entry) => JSON.stringify({
      version: 1,
      event: "catalogued",
      batchId: entry.batchId,
      ordinal: entry.ordinal,
      sha256: entry.sha256,
      relativePath: entry.relativePath,
      sizeBytes: entry.sizeBytes,
      modifiedUnix: entry.modifiedUnix,
      acknowledgedAt: new Date().toISOString(),
    }))
    .join("\n");
  const descriptor = fs.openSync(ledgerPath, "a", 0o600);
  try {
    fs.writeSync(descriptor, `${lines}\n`);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function loadUploadLedger(ledgerPath) {
  const confirmed = new Set();
  if (!fs.existsSync(ledgerPath)) return confirmed;
  const lines = fs.readFileSync(ledgerPath, "utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`upload ledger line ${index + 1} is not valid JSON`);
    }
    if (value?.event !== "catalogued" || typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
      throw new Error(`upload ledger line ${index + 1} is invalid`);
    }
    confirmed.add(value.sha256.toLowerCase());
  }
  return confirmed;
}

function parseManifest(content) {
  const text = content.replace(/^\uFEFF/, "").trim();
  if (!text) throw new Error("the upload manifest is empty");
  if (text.startsWith("{") || text.startsWith("[")) return parseJsonManifest(text);
  return parseCsvManifest(text);
}

function parseJsonManifest(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("the upload manifest is not valid JSON");
  }
  const rows = Array.isArray(value) ? value : value?.files;
  if (!Array.isArray(rows) || rows.length === 0) throw new Error("the upload manifest contains no files");
  return {
    batchId: stringValue(Array.isArray(value) ? null : value.batchId) || stringValue(rows[0]?.batchId) || "manifest",
    rows,
  };
}

function parseCsvManifest(text) {
  const records = parseCsv(text);
  if (records.length < 2) throw new Error("the CSV upload manifest contains no files");
  const headers = records[0].map(normalizeKey);
  const rows = records.slice(1).filter((record) => record.some((value) => value.trim())).map((record) => {
    const row = {};
    headers.forEach((header, index) => {
      row[header] = record[index] ?? "";
    });
    return row;
  });
  if (rows.length === 0) throw new Error("the CSV upload manifest contains no files");
  return { batchId: stringValue(rows[0]?.batchid) || "manifest", rows };
}

function normalizeEntry(row, index, defaultBatchId, sourceRoot) {
  if (!row || typeof row !== "object") throw new Error(`manifest row ${index + 1} is invalid`);
  const values = Object.fromEntries(Object.entries(row).map(([key, value]) => [normalizeKey(key), value]));
  const ordinal = positiveInteger(values.ordinal) ?? index + 1;
  const sha256 = stringValue(values.sha256).toLowerCase();
  const relativePath = stringValue(values.relativepath);
  const sourceValue = stringValue(values.sourcepath || values.fullpath || values.absolutepath || values.filepath);
  const sizeBytes = positiveInteger(values.sizebytes ?? values.size);
  const modifiedUnix = positiveNumber(values.modifiedunix ?? values.modifiedtime ?? values.mtime);
  if (!SHA256_PATTERN.test(sha256)) throw new Error(`manifest row ${ordinal} has an invalid SHA-256 digest`);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).some((part) => !part || part === "." || part === "..")) {
    throw new Error(`manifest row ${ordinal} has an invalid relative path`);
  }
  if (sizeBytes === null) throw new Error(`manifest row ${ordinal} has an invalid byte size`);
  if (modifiedUnix === null) throw new Error(`manifest row ${ordinal} has an invalid modification time`);
  const sourcePath = sourceValue
    ? path.resolve(sourceValue)
    : path.resolve(sourceRoot, ...relativePath.split(/[\\/]/));
  if (!isInside(sourceRoot, sourcePath)) throw new Error(`manifest row ${ordinal} escapes the source root`);
  let metadata;
  try {
    metadata = fs.statSync(sourcePath);
  } catch {
    throw new Error(`manifest row ${ordinal} source file is unavailable`);
  }
  if (!metadata.isFile()) throw new Error(`manifest row ${ordinal} does not identify a regular file`);
  if (metadata.size !== sizeBytes) throw new Error(`manifest row ${ordinal} byte size changed after catalogue creation`);
  const expectedModifiedMs = modifiedUnix > 10_000_000_000 ? modifiedUnix : modifiedUnix * 1_000;
  if (Math.abs(metadata.mtimeMs - expectedModifiedMs) > 2_000) {
    throw new Error(`manifest row ${ordinal} modification time changed after catalogue creation`);
  }
  return {
    batchId: stringValue(values.batchid) || defaultBatchId,
    ordinal,
    sha256,
    relativePath: relativePath.replaceAll("\\", "/"),
    sizeBytes,
    modifiedUnix,
    sourcePath,
  };
}

function parseCsv(text) {
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      record.push(field);
      field = "";
    } else if (character === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      record = [];
      field = "";
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error("the CSV upload manifest has an unterminated quoted field");
  record.push(field.replace(/\r$/, ""));
  records.push(record);
  return records;
}

function normalizeKey(value) {
  return String(value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stringValue(value) {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function positiveNumber(value) {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
