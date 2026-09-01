#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright";

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

    const picker = target.kind === "folder" ? page.locator("[data-upload-folder]") : page.locator("[data-upload-files]");
    await picker.setInputFiles(target.kind === "folder" ? target.path : target.paths);
    const selection = (await page.getByTestId("upload-selection").textContent())?.trim() ?? "";
    const selectedCount = Number.parseInt(selection, 10);
    if (!Number.isSafeInteger(selectedCount) || selectedCount < 1) {
      throw new Error("the selected path contains no supported audio files");
    }

    const sourceBytes = uploadPaths(target).reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
    const uploadStarted = performance.now();
    await page.getByTestId("upload").click();
    const completion = page.getByTestId("upload-progress").filter({ hasText: /tracks? added to the laptop library/i });
    await completion.waitFor({ timeout: options.timeoutMs });
    const completionText = (await completion.textContent())?.trim() ?? "";
    const imported = await page.locator(".imported-list li").evaluateAll((items) =>
      items.map((item) => ({
        title: item.querySelector("strong")?.textContent?.trim() ?? "",
        details: item.querySelector("span")?.textContent?.trim() ?? "",
      })),
    );
    if (browserErrors.length > 0) throw new Error(browserErrors.join(" | "));
    const uploadMs = Math.max(1, Math.round(performance.now() - uploadStarted));
    return {
      status: "uploaded",
      source: target.kind,
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

function parseArguments(argumentsList) {
  const options = {
    files: [],
    folder: null,
    passwordFile: process.env.ZURADIO_PASSWORD_FILE ?? null,
    url: process.env.ZURADIO_URL ?? DEFAULT_URL,
    browserExecutable: process.env.ZURADIO_BROWSER_EXECUTABLE || undefined,
    timeoutMs: 180_000,
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
    } else if (argument === "--password-file") {
      options.passwordFile = readValue(argumentsList, ++index, argument);
    } else if (argument === "--url") {
      options.url = readValue(argumentsList, ++index, argument);
    } else if (argument === "--browser-executable") {
      options.browserExecutable = readValue(argumentsList, ++index, argument);
    } else if (argument === "--timeout-ms") {
      options.timeoutMs = Number(readValue(argumentsList, ++index, argument));
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.help) return options;
  if (!options.passwordFile) throw new Error("pass --password-file or set ZURADIO_PASSWORD_FILE");
  if (options.files.length === 0 && !options.folder) throw new Error("pass at least one --file or one --folder");
  if (options.files.length > 0 && options.folder) throw new Error("use --file or --folder, not both in one upload");
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 10_000 || options.timeoutMs > 900_000) {
    throw new Error("--timeout-ms must be an integer between 10000 and 900000");
  }
  return options;
}

function resolveUploadTarget(options) {
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

Options:
  --url URL                 Companion URL (defaults to the public Zuradio site)
  --browser-executable PATH Use a specific Chrome, Brave, or Chromium executable
  --headed                  Show the automation browser while uploading
  --timeout-ms NUMBER       Connection/upload timeout (default: 180000)

The password is read only from a file, never from a command-line value. On
success the command prints machine-readable JSON. Music travels directly to
the active laptop through the companion's encrypted WebRTC bridge.
`;
}
