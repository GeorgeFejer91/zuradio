#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

import { appendUploadLedger, loadUploadManifest } from "./upload-manifest.mjs";

const DEFAULT_URL = "https://georgefejer91.github.io/zuradio/";
const SUPPORTED_EXTENSIONS = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".alac",
  ".flac",
  ".m4a",
  ".mp3",
  ".mp4",
  ".ogg",
  ".opus",
  ".wav",
  ".webm",
]);

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  const result = await upload(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`Zuradio upload failed: ${messageOf(error)}\n`);
  process.exit(1);
}

async function upload(options) {
  const passwordPath = resolveRequiredFile(options.passwordFile, "password file");
  const password = fs.readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");
  if (password.length < 8 || password.length > 256) {
    throw new Error("the password file must contain 8 to 256 bytes");
  }

  const target = resolveUploadTarget(options);
  if (target.kind === "manifest") {
    const skippedFiles = target.plannedEntries.length - target.pendingEntries.length;
    writeProgress(
      "resume",
      `${target.batchId} · ${skippedFiles} confirmed hash${skippedFiles === 1 ? "" : "es"} skipped · ${target.pendingEntries.length} pending`,
    );
    if (target.pendingEntries.length === 0) {
      return {
        status: "already_uploaded",
        source: "manifest",
        batchId: target.batchId,
        plannedFiles: target.plannedEntries.length,
        selectedFiles: 0,
        skippedFiles,
        importedTracks: 0,
        sourceBytes: 0,
        connectionMs: 0,
        uploadMs: 0,
        bytesPerSecond: 0,
        message: "Every manifest hash already has a durable receiver catalogue acknowledgement",
        imported: [],
      };
    }
  }
  const publicUrl = validateCompanionUrl(options.url);
  const browser = await chromium.launch({
    headless: !options.headed,
    executablePath: options.browserExecutable,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });

  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const browserErrors = [];
    page.on("pageerror", (event) => browserErrors.push(event.message));
    await page.goto(publicUrl, { waitUntil: "domcontentloaded", timeout: options.timeoutMs });
    await page.getByTestId("connect-upload").click();
    await page.getByTestId("password").fill(password);
    const connectionStarted = performance.now();
    await page.getByTestId("connect").click();
    try {
      await page.getByText("Upload connected", { exact: true }).waitFor({ timeout: options.timeoutMs });
    } catch (error) {
      const alert = await page.getByRole("alert").textContent().catch(() => "");
      throw new Error(alert?.trim() || browserErrors.at(-1) || messageOf(error));
    }
    const connectionMs = Math.round(performance.now() - connectionStarted);
    writeProgress("connection", `Upload connected in ${connectionMs} ms`);

    const sourcePaths = uploadPaths(target);
    if (sourcePaths.length < 1) throw new Error("the selected path contains no supported audio files");
    await selectUploadFiles(page, target, sourcePaths.length);
    const selectedCount = sourcePaths.length;
    const sourceBytes = sourcePaths.reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
    writeProgress(
      "selection",
      `${selectedCount} file${selectedCount === 1 ? "" : "s"} ready · ${sourceBytes} bytes`,
    );
    const recordCatalogued = target.kind === "manifest"
      ? (count, sha256) => recordManifestAcknowledgement(target, count, sha256)
      : null;
    const progressMonitor = await attachUploadProgress(page, recordCatalogued);
    const uploadStarted = performance.now();
    await page.getByTestId("upload").click();
    const completion = page.getByTestId("upload-progress").filter({ hasText: /tracks? added to the laptop library/i });
    try {
      await Promise.race([
        completion.waitFor({ timeout: options.uploadTimeoutMs }),
        page
          .getByRole("alert")
          .waitFor({ state: "visible", timeout: options.uploadTimeoutMs })
          .then(() => Promise.reject(new Error("the receiving laptop reported an upload error"))),
      ]);
    } catch (error) {
      await progressMonitor.flush();
      const alert = (await page.getByRole("alert").textContent().catch(() => ""))?.trim();
      const progress = (await page.getByTestId("upload-progress").textContent().catch(() => ""))?.trim();
      const reason = progressMonitor.errorMessage() || alert || browserErrors.at(-1) || messageOf(error);
      throw new Error(progress ? `${reason} (last receiver stage: ${progress})` : reason);
    }
    const completionText = (await completion.textContent())?.trim() ?? "";
    const imported = await page.locator(".imported-list li").evaluateAll((items) =>
      items.map((item) => ({
        title: item.querySelector("strong")?.textContent?.trim() ?? "",
        details: item.querySelector("span")?.textContent?.trim() ?? "",
      })),
    );
    if (imported.length !== selectedCount) {
      throw new Error(`receiver acknowledged ${imported.length} of ${selectedCount} selected tracks`);
    }
    await progressMonitor.flush();
    progressMonitor.throwIfError();
    if (target.kind === "manifest") {
      const unconfirmed = target.pendingEntries.filter((entry) => !target.confirmed.has(entry.sha256));
      if (unconfirmed.length > 0) {
        throw new Error(`receiver catalogue digest acknowledgement is missing for ${unconfirmed.length} imported track${unconfirmed.length === 1 ? "" : "s"}`);
      }
    }
    if (browserErrors.length > 0) throw new Error(browserErrors.join(" | "));
    const uploadMs = Math.max(1, Math.round(performance.now() - uploadStarted));
    return {
      status: "uploaded",
      source: target.kind,
      ...(target.kind === "manifest"
        ? {
            batchId: target.batchId,
            plannedFiles: target.plannedEntries.length,
            skippedFiles: target.plannedEntries.length - target.pendingEntries.length,
          }
        : {}),
      selectedFiles: selectedCount,
      importedTracks: imported.length,
      sourceBytes,
      connectionMs,
      uploadMs,
      bytesPerSecond: Math.round(sourceBytes / (uploadMs / 1_000)),
      message: completionText,
      imported,
    };
  } finally {
    await browser.close();
  }
}

function recordManifestAcknowledgement(target, count, acknowledgedSha256) {
  if (!Number.isSafeInteger(count) || count < 1 || count > target.pendingEntries.length) {
    throw new Error("receiver returned an invalid manifest catalogue count");
  }
  if (typeof acknowledgedSha256 !== "string" || !/^[0-9a-f]{64}$/i.test(acknowledgedSha256)) {
    throw new Error("receiver catalogue acknowledgement omitted its verified SHA-256 digest");
  }
  const entry = target.pendingEntries[count - 1];
  if (!entry || entry.sha256 !== acknowledgedSha256.toLowerCase()) {
    throw new Error(`receiver catalogue digest differs from manifest row ${entry?.ordinal ?? count}`);
  }
  for (const earlier of target.pendingEntries.slice(0, count - 1)) {
    if (!target.confirmed.has(earlier.sha256)) {
      throw new Error("receiver catalogue digest acknowledgements arrived out of order");
    }
  }
  if (target.confirmed.has(entry.sha256)) return;
  appendUploadLedger(target.ledgerPath, [entry]);
  target.confirmed.add(entry.sha256);
  writeProgress(
    "ledger",
    `${target.confirmed.size} receiver-acknowledged hash${target.confirmed.size === 1 ? "" : "es"} recorded`,
  );
}

async function attachUploadProgress(page, onCatalogued = null) {
  let lastText = "";
  let lastCatalogued = 0;
  let lastPrintedAt = 0;
  let progressError = null;
  await page.exposeFunction("__zuradioCliUploadProgress", (value) => {
    const text = String(value).replace(/\s+/g, " ").trim();
    if (!text || text === lastText) return;
    lastText = text;
    const catalogued = Number.parseInt(text.match(/(?:^|·)\s*(\d+) catalogued on laptop/)?.[1] ?? "", 10);
    const now = Date.now();
    const milestone =
      text.startsWith("Starting secure transfer") ||
      /tracks? added to the laptop library/.test(text) ||
      (Number.isSafeInteger(catalogued) && catalogued !== lastCatalogued);
    if (!milestone && now - lastPrintedAt < 5_000) return;
    lastPrintedAt = now;
    writeProgress("receiver", text);
  });
  await page.exposeFunction("__zuradioCliUploadAcknowledgement", (value) => {
    if (progressError || !value || value.phase !== "catalogued") return;
    try {
      onCatalogued?.(value.cataloguedCount, value.sha256);
    } catch (error) {
      progressError = error;
    }
  });
  await page.evaluate(() => {
    const app = document.querySelector("#app");
    if (!app) throw new Error("the companion upload interface is unavailable");
    const report = () => {
      const text = app.querySelector("[data-testid='upload-progress']")?.textContent ?? "";
      void window.__zuradioCliUploadProgress(text);
    };
    new MutationObserver(report).observe(app, { childList: true, subtree: true, characterData: true });
    window.addEventListener("zuradio-upload-progress", (event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const pending = window.__zuradioCliUploadAcknowledgementQueue ?? Promise.resolve();
      window.__zuradioCliUploadAcknowledgementQueue = pending.then(() =>
        window.__zuradioCliUploadAcknowledgement(detail),
      );
    });
    report();
  });
  return {
    flush: () => page.evaluate(async () => {
      await window.__zuradioCliUploadAcknowledgementQueue;
    }),
    errorMessage: () => progressError ? messageOf(progressError) : "",
    throwIfError: () => {
      if (progressError) throw progressError;
    },
  };
}

function writeProgress(stage, detail) {
  process.stderr.write(`Zuradio ${stage}: ${detail}\n`);
}

async function selectUploadFiles(page, target, expectedCount) {
  const expectedText = `${expectedCount} file${expectedCount === 1 ? "" : "s"} selected`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const picker =
      target.kind === "folder" ? page.locator("[data-upload-folder]") : page.locator("[data-upload-files]");
    const inputFiles = target.kind === "folder"
      ? target.path
      : target.kind === "manifest"
        ? target.pendingEntries.map((entry) => entry.sourcePath)
        : target.paths;
    await picker.setInputFiles(inputFiles);
    if (target.kind === "manifest") {
      await picker.evaluate((input, relativePaths) => {
        const files = Array.from(input.files ?? []);
        if (files.length !== relativePaths.length) throw new Error("the browser selected an incomplete manifest batch");
        files.forEach((file, index) => {
          Object.defineProperty(file, "webkitRelativePath", {
            configurable: true,
            value: relativePaths[index],
          });
        });
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
      }, target.pendingEntries.map((entry) => entry.relativePath));
    }
    try {
      const selectionTimeoutMs = Math.min(120_000, 5_000 + expectedCount * 10);
      await page.getByTestId("upload-selection").filter({ hasText: expectedText }).waitFor({
        timeout: selectionTimeoutMs,
      });
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

function parseArguments(argumentsList) {
  const options = {
    files: [],
    folder: null,
    manifest: null,
    sourceRoot: process.env.ZURADIO_SOURCE_ROOT ?? null,
    ledger: process.env.ZURADIO_UPLOAD_LEDGER ?? null,
    passwordFile: process.env.ZURADIO_PASSWORD_FILE ?? null,
    url: process.env.ZURADIO_URL ?? DEFAULT_URL,
    browserExecutable: process.env.ZURADIO_BROWSER_EXECUTABLE || undefined,
    timeoutMs: 180_000,
    uploadTimeoutMs: 8 * 60 * 60 * 1_000,
    headed: false,
    help: false,
  };
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else if (argument === "--headed") {
      options.headed = true;
    } else if (argument === "--file") {
      options.files.push(readValue(argumentsList, ++index, argument));
    } else if (argument === "--folder") {
      options.folder = readValue(argumentsList, ++index, argument);
    } else if (argument === "--manifest") {
      options.manifest = readValue(argumentsList, ++index, argument);
    } else if (argument === "--source-root") {
      options.sourceRoot = readValue(argumentsList, ++index, argument);
    } else if (argument === "--ledger") {
      options.ledger = readValue(argumentsList, ++index, argument);
    } else if (argument === "--password-file") {
      options.passwordFile = readValue(argumentsList, ++index, argument);
    } else if (argument === "--url") {
      options.url = readValue(argumentsList, ++index, argument);
    } else if (argument === "--browser-executable") {
      options.browserExecutable = readValue(argumentsList, ++index, argument);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(readValue(argumentsList, ++index, argument));
    } else if (argument === "--upload-timeout-ms") {
      options.uploadTimeoutMs = Number(readValue(argumentsList, ++index, argument));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (!options.passwordFile) throw new Error("pass --password-file or set ZURADIO_PASSWORD_FILE");
  const sourceModes = Number(options.files.length > 0) + Number(Boolean(options.folder)) + Number(Boolean(options.manifest));
  if (sourceModes === 0) throw new Error("pass --file, --folder, or --manifest");
  if (sourceModes > 1) throw new Error("use only one of --file, --folder, or --manifest");
  if (options.manifest && (!options.sourceRoot || !options.ledger)) {
    throw new Error("--manifest requires --source-root and --ledger (or their environment variables)");
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer between 10000 and 900000");
  }
  if (
    !Number.isSafeInteger(options.uploadTimeoutMs) ||
    options.uploadTimeoutMs < 10_000 ||
    options.uploadTimeoutMs > 86_400_000
  ) {
    throw new Error("--upload-timeout-ms must be an integer between 10000 and 86400000");
  }
  return options;
}

function resolveUploadTarget(options) {
  if (options.manifest) {
    const manifestPath = resolveRequiredFile(options.manifest, "upload manifest");
    const ledgerPath = path.resolve(options.ledger);
    const manifest = loadUploadManifest(manifestPath, options.sourceRoot, ledgerPath);
    for (const entry of manifest.plannedEntries) {
      if (!SUPPORTED_EXTENSIONS.has(path.extname(entry.relativePath).toLocaleLowerCase())) {
        throw new Error(`manifest row ${entry.ordinal} names an unsupported audio file`);
      }
    }
    return {
      kind: "manifest",
      ...manifest,
      ledgerPath,
    };
  }
  if (options.folder) {
    const folderPath = path.resolve(options.folder);
    if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
      throw new Error(`upload folder does not exist: ${folderPath}`);
    }
    return { kind: "folder", path: folderPath };
  }
  const paths = options.files.map((file) => resolveRequiredFile(file, "music file"));
  for (const filePath of paths) {
    if (!SUPPORTED_EXTENSIONS.has(path.extname(filePath).toLocaleLowerCase())) {
      throw new Error(`unsupported audio file: ${filePath}`);
    }
  }
  return { kind: "files", paths };
}

function resolveRequiredFile(value, label) {
  if (!value) throw new Error(`missing ${label}`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function uploadPaths(target) {
  if (target.kind === "files") return target.paths;
  if (target.kind === "manifest") return target.pendingEntries.map((entry) => entry.sourcePath);
  const files = [];
  const pending = [target.path];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLocaleLowerCase())) {
        files.push(entryPath);
      }
    }
  }
  return files;
}

function validateCompanionUrl(value) {
  const url = new URL(value);
  const loopbackHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error("the companion URL must use HTTPS (or loopback HTTP for local tests)");
  }
  return url.href;
}

function readValue(argumentsList, index, option) {
  const value = argumentsList[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function usage() {
  return `Usage:
  npm run upload -- --password-file PATH --file SONG [--file SONG ...]
  npm run upload -- --password-file PATH --folder MUSIC_FOLDER
  npm run upload -- --password-file PATH --manifest BATCH.csv --source-root MUSIC_ROOT --ledger ACKS.jsonl

Options:
  --manifest PATH            JSON or CSV catalogue batch with SHA-256 and relative paths
  --source-root PATH         Local-only root used to resolve and constrain manifest files
  --ledger PATH              Append-only receiver catalogue-acknowledgement ledger
  --url URL                 Companion URL (defaults to the public Zuradio site)
  --browser-executable PATH Use a specific Chrome, Brave, or Chromium executable
  --headed                  Show the automation browser while uploading
  --timeout-ms NUMBER       Page and connection timeout (default: 180000)
  --upload-timeout-ms N     Whole-upload timeout (default: 28800000; max: 86400000)

The password is read only from a file, never from a command-line value. On
success the command prints machine-readable JSON. Music travels directly to
the active laptop through the companion's encrypted WebRTC bridge. Manifest
mode validates source size and modification time, preserves relative paths,
and skips hashes already recorded in the fsynced acknowledgement ledger.
`;
}
