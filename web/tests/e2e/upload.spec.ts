import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { expect, test, type Browser, type Page } from "@playwright/test";

interface RuntimeFile {
  hostUrl: string;
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeFile;
const passwordPath = process.env.ZURADIO_TEST_PASSWORD_FILE;
if (!passwordPath) throw new Error("ZURADIO_TEST_PASSWORD_FILE must name the daemon password file");
const password = fs.readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");
const fixture = process.env.ZURADIO_UPLOAD_FIXTURE;
const fixtureFolder = process.env.ZURADIO_UPLOAD_FOLDER;
const expectedTitle = process.env.ZURADIO_UPLOAD_EXPECTED_TITLE ?? "Zuradio Upload Fixture";
const companionBase = process.env.ZURADIO_COMPANION_BASE ?? "http://127.0.0.1:4173";
const uploadCli = fileURLToPath(new URL("../../scripts/upload-cli.mjs", import.meta.url));
const execFileAsync = promisify(execFile);
const WINDOWS_CHROME_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

test("rejects a wrong password before exposing live audio", async ({ browser }) => {
  test.setTimeout(70_000);
  const host = await authenticatedHost(browser);
  try {
    await startFreshBroadcast(host);
    const companion = await browser.newPage();
    await companion.goto(companionBase);
    await companion.getByTestId("connect-listen").click();
    await companion.getByTestId("password").fill("definitely-the-wrong-password");
    await companion.getByTestId("connect").click();
    await expect(companion.getByRole("alert")).toContainText(/No active Zuradio broadcast/i, { timeout: 35_000 });
    const hasAudio = await companion.evaluate(() => {
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-label="Live Zuradio audio"]');
      return Boolean(audio?.srcObject && (audio.srcObject as MediaStream).getAudioTracks().length);
    });
    expect(hasAudio).toBe(false);
  } finally {
    await stopBroadcast(host);
  }
});

test("switches from control to upload and exposes the catalogued result", async ({ browser }) => {
  test.skip(!fixture || !fs.existsSync(fixture), "Set ZURADIO_UPLOAD_FIXTURE to a valid audio file");
  test.setTimeout(150_000);
  const host = await authenticatedHost(browser);
  try {
    await startFreshBroadcast(host);
    const uploader = await browser.newPage();
    await uploader.goto(companionBase);
    await uploader.setViewportSize({ width: 390, height: 844 });
    await uploader.getByTestId("connect-control").click();
    await uploader.getByTestId("password").fill(password);
    await uploader.getByTestId("connect").click();
    await expect(uploader.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await uploader.getByTestId("switch-upload").click();
    await expect(uploader.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(uploader.getByRole("dialog")).toHaveCount(0);
    await uploader.locator("[data-upload-files]").setInputFiles(fixture as string);
    await expect(uploader.getByText("1 file selected", { exact: true })).toBeVisible();
    await uploader.screenshot({ path: "test-results/mobile-upload-file-selection.png", fullPage: true });
    const startedAt = Date.now();
    await uploader.getByTestId("upload").click();
    await expect(uploader.getByText(expectedTitle, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(uploader.getByText(/1 track added to the laptop library/)).toBeVisible();
    const elapsedSeconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
    const uploadBytesPerSecond = fs.statSync(fixture as string).size / elapsedSeconds;
    test.info().annotations.push({
      type: "performance",
      description: `Authenticated WebRTC upload: ${Math.round(uploadBytesPerSecond)} bytes/s`,
    });
    expect(uploadBytesPerSecond).toBeGreaterThan(32 * 1024);

    await host.getByRole("button", { name: /Library/ }).click();
    await host.getByTestId("search").fill(expectedTitle);
    await expect.poll(() => host.locator("[data-track-row]").count()).toBeGreaterThan(0);
    await expect(host.locator("[data-track-row]").first()).toContainText(expectedTitle);
  } finally {
    await stopBroadcast(host);
  }
});

test("uploads from a Windows Chromium profile while ignoring a competing stale host", async ({ browser }) => {
  test.skip(!fixture || !fs.existsSync(fixture), "Set ZURADIO_UPLOAD_FIXTURE to a valid audio file");
  test.setTimeout(180_000);
  const staleHost = await authenticatedHost(browser);
  let currentHost: Page | null = null;
  const windowsContext = await browser.newContext({
    userAgent: WINDOWS_CHROME_USER_AGENT,
    viewport: { width: 1366, height: 768 },
  });
  try {
    await startFreshBroadcast(staleHost);
    await staleHost.waitForTimeout(750);

    currentHost = await authenticatedHost(browser);
    await currentHost.getByRole("button", { name: /Broadcast/ }).click();
    await currentHost.getByTestId("restart-broadcast").click();
    await expect(currentHost.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
    await expect(staleHost.getByText("A newer Zuradio window replaced this remote-access beacon", { exact: true })).toBeVisible({
      timeout: 5_000,
    });

    const uploader = await windowsContext.newPage();
    await uploader.goto(companionBase);
    expect(await uploader.evaluate(() => navigator.userAgent)).toContain("Windows NT 10.0");
    await uploader.getByTestId("connect-upload").click();
    await uploader.getByTestId("password").fill(password);
    const connectedAt = Date.now();
    await uploader.getByTestId("connect").click();
    await expect(uploader.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 60_000 });
    expect(Date.now() - connectedAt, "Windows upload connection latency with a stale host").toBeLessThan(30_000);
    await expect(uploader.getByRole("alert")).toHaveCount(0);
    await uploader.locator("[data-upload-files]").setInputFiles(fixture as string);
    await expect(uploader.getByTestId("upload-selection")).toHaveText("1 file selected");
    await uploader.getByTestId("upload").click();
    await expect(uploader.getByText(expectedTitle, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(uploader.getByTestId("upload-progress")).toContainText("1 track added to the laptop library");
  } finally {
    await windowsContext.close().catch(() => undefined);
    if (currentHost) await stopBroadcast(currentHost);
    await staleHost.close().catch(() => undefined);
  }
});

test("uploads an individual file through the external browser CLI", async ({ browser }) => {
  test.skip(!fixture || !fs.existsSync(fixture), "Set ZURADIO_UPLOAD_FIXTURE to a valid audio file");
  test.setTimeout(240_000);
  const host = await authenticatedHost(browser);
  try {
    await startFreshBroadcast(host);
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        uploadCli,
        "--url",
        companionBase,
        "--password-file",
        passwordPath,
        "--file",
        fixture as string,
      ],
      { timeout: 210_000, maxBuffer: 1024 * 1024 },
    );
    expect(stderr).not.toContain("Zuradio upload failed");
    expect(stderr).toContain("Zuradio connection: Upload connected");
    expect(stderr).toContain("Zuradio selection: 1 file ready");
    expect(stderr).toContain("Zuradio receiver: Starting secure transfer");
    expect(stderr).toMatch(/Zuradio receiver: 1\/1 .* 100% · 1 catalogued on laptop/);
    expect(stderr).toContain("Zuradio receiver: 1 track added to the laptop library");
    const result = JSON.parse(stdout) as {
      status: string;
      source: string;
      selectedFiles: number;
      importedTracks: number;
      sourceBytes: number;
      connectionMs: number;
      uploadMs: number;
      bytesPerSecond: number;
    };
    expect(result).toMatchObject({
      status: "uploaded",
      source: "files",
      selectedFiles: 1,
      importedTracks: 1,
    });
    expect(result.sourceBytes).toBe(fs.statSync(fixture as string).size);
    expect(result.connectionMs).toBeLessThan(30_000);
    expect(result.uploadMs).toBeGreaterThan(0);
    expect(result.bytesPerSecond).toBeGreaterThan(32 * 1024);
  } finally {
    await stopBroadcast(host);
  }
});

test("resumes a catalogue manifest from its durable receiver-ack ledger", async ({ browser }) => {
  test.skip(!fixture || !fs.existsSync(fixture), "Set ZURADIO_UPLOAD_FIXTURE to a valid audio file");
  test.setTimeout(300_000);
  const host = await authenticatedHost(browser);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zuradio-cli-manifest-"));
  try {
    await startFreshBroadcast(host);
    const sourcePath = fixture as string;
    const sourceRoot = path.dirname(sourcePath);
    const metadata = fs.statSync(sourcePath);
    const sha256 = createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
    const manifestPath = path.join(directory, "batch.json");
    const ledgerPath = path.join(directory, "catalogued.jsonl");
    fs.writeFileSync(manifestPath, JSON.stringify({
      batchId: "qualification-batch-001",
      files: [{
        ordinal: 1,
        sha256,
        relativePath: `Manifest Artist/Manifest Album/${path.basename(sourcePath)}`,
        filename: path.basename(sourcePath),
        extension: path.extname(sourcePath),
        sizeBytes: metadata.size,
        modifiedUnix: metadata.mtimeMs / 1_000,
        sourcePath,
      }],
    }));
    const argumentsList = [
      uploadCli,
      "--url",
      companionBase,
      "--password-file",
      passwordPath,
      "--manifest",
      manifestPath,
      "--source-root",
      sourceRoot,
      "--ledger",
      ledgerPath,
    ];

    const first = await execFileAsync(process.execPath, argumentsList, {
      timeout: 210_000,
      maxBuffer: 1024 * 1024,
    });
    expect(first.stderr).toContain("Zuradio resume: qualification-batch-001 · 0 confirmed hashes skipped · 1 pending");
    expect(first.stderr).toContain("Zuradio ledger: 1 receiver-acknowledged hash recorded");
    expect(first.stderr).not.toContain(sourceRoot);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "uploaded",
      source: "manifest",
      batchId: "qualification-batch-001",
      plannedFiles: 1,
      selectedFiles: 1,
      skippedFiles: 0,
      importedTracks: 1,
    });
    const ledgerLines = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
    expect(ledgerLines).toHaveLength(1);
    expect(JSON.parse(ledgerLines[0] ?? "{}")).toMatchObject({ event: "catalogued", sha256 });

    const resumed = await execFileAsync(process.execPath, argumentsList, {
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    });
    expect(resumed.stderr).toContain("1 confirmed hash skipped · 0 pending");
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: "already_uploaded",
      source: "manifest",
      plannedFiles: 1,
      selectedFiles: 0,
      skippedFiles: 1,
      importedTracks: 0,
    });
    expect(fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/)).toHaveLength(1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
    await stopBroadcast(host);
  }
});

test("resumes an interrupted manifest without resending a receiver-acknowledged hash", async ({ browser }) => {
  test.setTimeout(360_000);
  const host = await authenticatedHost(browser);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "zuradio-cli-interrupted-manifest-"));
  try {
    await startFreshBroadcast(host);
    const sources = ["01 - first.wav", "02 - second.wav"].map((name, index) => {
      const sourcePath = path.join(directory, name);
      fs.writeFileSync(sourcePath, minimalWav(index + 1));
      const metadata = fs.statSync(sourcePath);
      return {
        ordinal: index + 1,
        sha256: createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex"),
        relativePath: `Resume Artist/Resume Album/${name}`,
        filename: name,
        extension: ".wav",
        sizeBytes: metadata.size,
        modifiedUnix: metadata.mtimeMs / 1_000,
        sourcePath,
      };
    });
    const manifestPath = path.join(directory, "interrupted-batch.json");
    const ledgerPath = path.join(directory, "catalogued.jsonl");
    fs.writeFileSync(manifestPath, JSON.stringify({ batchId: "qualification-interrupted-001", files: sources }));
    const argumentsList = [
      uploadCli,
      "--url",
      companionBase,
      "--password-file",
      passwordPath,
      "--manifest",
      manifestPath,
      "--source-root",
      directory,
      "--ledger",
      ledgerPath,
      "--timeout-ms",
      "60000",
    ];

    let firstFileId: string | null = null;
    let rejectedSecondFile = false;
    await host.route("**/api/v1/remote/upload", async (route) => {
      const body = route.request().postDataJSON() as {
        operation?: { kind?: string; fileId?: string; files?: Array<{ fileId?: string }> };
      };
      const operation = body.operation;
      if (operation?.kind === "begin" && !firstFileId) firstFileId = operation.files?.[0]?.fileId ?? null;
      if (operation?.kind === "chunk" && firstFileId && operation.fileId !== firstFileId) {
        rejectedSecondFile = true;
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "storage",
            message: "forced second-file receiver gate rejection",
            revision: null,
          }),
        });
        return;
      }
      await route.continue();
    });

    const interrupted = await execFileAsync(process.execPath, argumentsList, {
      timeout: 210_000,
      maxBuffer: 1024 * 1024,
    }).then(
      (result) => ({ failed: false, stdout: result.stdout, stderr: result.stderr }),
      (error: unknown) => ({
        failed: true,
        stdout: String((error as { stdout?: string }).stdout ?? ""),
        stderr: String((error as { stderr?: string }).stderr ?? error),
      }),
    );
    expect(interrupted.failed).toBe(true);
    expect(rejectedSecondFile).toBe(true);
    expect(interrupted.stderr).toContain("1 receiver-acknowledged hash recorded");
    expect(interrupted.stderr).toContain("forced second-file receiver gate rejection");
    const interruptedLedger = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
    expect(interruptedLedger).toHaveLength(1);
    expect(JSON.parse(interruptedLedger[0] ?? "{}")).toMatchObject({ sha256: sources[0]?.sha256 });

    await host.unroute("**/api/v1/remote/upload");
    const resumed = await execFileAsync(process.execPath, argumentsList, {
      timeout: 210_000,
      maxBuffer: 1024 * 1024,
    });
    expect(resumed.stderr).toContain("1 confirmed hash skipped · 1 pending");
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      status: "uploaded",
      source: "manifest",
      batchId: "qualification-interrupted-001",
      plannedFiles: 2,
      selectedFiles: 1,
      skippedFiles: 1,
      importedTracks: 1,
    });
    const resumedLedger = fs.readFileSync(ledgerPath, "utf8").trim().split(/\r?\n/);
    expect(resumedLedger).toHaveLength(2);
    expect(resumedLedger.map((line) => JSON.parse(line).sha256)).toEqual(sources.map((entry) => entry.sha256));
    expect(fs.readFileSync(ledgerPath, "utf8")).not.toContain(directory);
  } finally {
    await host.unroute("**/api/v1/remote/upload").catch(() => undefined);
    fs.rmSync(directory, { recursive: true, force: true });
    await stopBroadcast(host);
  }
});

test("CLI reports the receiver's first-chunk failure instead of a final timeout", async ({ browser }) => {
  test.skip(!fixture || !fs.existsSync(fixture), "Set ZURADIO_UPLOAD_FIXTURE to a valid audio file");
  test.setTimeout(150_000);
  const host = await authenticatedHost(browser);
  try {
    await startFreshBroadcast(host);
    let rejectedChunk = false;
    let rejectedAt = 0;
    await host.route("**/api/v1/remote/upload", async (route) => {
      const body = route.request().postDataJSON() as { operation?: { kind?: string } };
      if (body.operation?.kind === "chunk") {
        if (!rejectedChunk) {
          rejectedChunk = true;
          rejectedAt = Date.now();
        }
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            code: "storage",
            message: "forced first-chunk receiver gate rejection",
            revision: null,
          }),
        });
        return;
      }
      await route.continue();
    });

    const cliResult = execFileAsync(
        process.execPath,
        [
          uploadCli,
          "--url",
          companionBase,
          "--password-file",
          passwordPath,
          "--file",
          fixture as string,
          "--timeout-ms",
          "60000",
        ],
        { timeout: 120_000, maxBuffer: 1024 * 1024 },
      ).then(
        (result) => ({ stderr: result.stderr }),
        (error: unknown) => ({ stderr: String((error as { stderr?: string }).stderr ?? error) }),
      );
    await expect(host.getByTestId("local-transfer-status")).toContainText(
      "forced first-chunk receiver gate rejection",
      { timeout: 60_000 },
    );
    const { stderr } = await cliResult;
    expect(rejectedChunk).toBe(true);
    expect(Date.now() - rejectedAt, "CLI must surface a receiver failure without waiting for final success").toBeLessThan(
      15_000,
    );
    expect(stderr).toContain("forced first-chunk receiver gate rejection");
    expect(stderr).toContain("last receiver stage:");
    expect(stderr).not.toContain("waiting for locator");
  } finally {
    await stopBroadcast(host);
  }
});

test("selects a folder, ignores non-audio files, and imports every track", async ({ browser }) => {
  test.skip(!fixtureFolder || !fs.existsSync(fixtureFolder), "Set ZURADIO_UPLOAD_FOLDER to an audio folder");
  test.setTimeout(240_000);
  const host = await authenticatedHost(browser);
  try {
    await startFreshBroadcast(host);
    const uploader = await browser.newPage();
    await uploader.goto(companionBase);
    await uploader.setViewportSize({ width: 390, height: 844 });
    await uploader.getByTestId("connect-upload").click();
    await uploader.getByTestId("password").fill(password);
    await uploader.getByTestId("connect").click();
    await expect(uploader.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await host.getByRole("button", { name: /Library/ }).click();
    const hostTrackCount = await host.locator("[data-track-row]").count();
    await uploader.locator("[data-upload-folder]").setInputFiles(fixtureFolder as string);
    await expect(uploader.getByText("3 files selected", { exact: true })).toBeVisible();
    await uploader.screenshot({ path: "test-results/mobile-upload-folder-selection.png", fullPage: true });
    await uploader.getByTestId("upload").click();
    await expect(uploader.getByTestId("upload-progress")).toContainText("1 catalogued on laptop", {
      timeout: 90_000,
    });
    await expect.poll(() => host.locator("[data-track-row]").count()).toBeGreaterThan(hostTrackCount);
    await expect(uploader.getByText(/3 tracks added to the laptop library/)).toBeVisible({ timeout: 180_000 });
    await expect(uploader.locator(".imported-list li")).toHaveCount(3);
  } finally {
    await stopBroadcast(host);
  }
});

test("splits a large declaration into bounded transactions while keeping global progress", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const host = await authenticatedHost(browser);
  const declaredBatchSizes: number[] = [];
  host.on("request", (request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/api/v1/remote/upload")) return;
    try {
      const body = request.postDataJSON() as { operation?: { kind?: string; files?: unknown[] } };
      if (body.operation?.kind === "begin" && Array.isArray(body.operation.files)) {
        declaredBatchSizes.push(body.operation.files.length);
      }
    } catch {
      // Only valid JSON upload declarations are relevant to this assertion.
    }
  });
  try {
    await startFreshBroadcast(host);
    const uploader = await browser.newPage();
    await uploader.goto(companionBase);
    await uploader.setViewportSize({ width: 390, height: 844 });
    await uploader.getByTestId("connect-upload").click();
    await uploader.getByTestId("password").fill(password);
    await uploader.getByTestId("connect").click();
    await expect(uploader.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 45_000 });

    const files = Array.from({ length: 8 }, (_, index) => ({
      name: `${"🎵".repeat(490)}-${index}.wav`,
      mimeType: "audio/wav",
      buffer: minimalWav(index),
    }));
    await uploader.locator("[data-upload-files]").setInputFiles(files);
    await expect(uploader.getByTestId("upload-selection")).toHaveText("8 files selected");
    await uploader.evaluate(() => {
      const history: string[] = [];
      Object.defineProperty(window, "__zuradioBulkProgress", { value: history });
      const app = document.querySelector("#app");
      if (app) {
        new MutationObserver(() => {
          const value = app.querySelector("[data-testid='upload-progress']")?.textContent ?? "";
          if (value && history.at(-1) !== value) history.push(value);
        }).observe(app, {
          childList: true,
          subtree: true,
        });
      }
    });

    await uploader.getByTestId("upload").click();
    await expect(uploader.getByTestId("upload-progress")).toContainText("8 tracks added to the laptop library", {
      timeout: 120_000,
    });
    await expect(uploader.locator(".imported-list li")).toHaveCount(8);
    await expect(host.getByTestId("local-transfer-status")).toContainText("Transfer complete");
    const progressHistory = await uploader.evaluate(
      () => (window as unknown as { __zuradioBulkProgress: string[] }).__zuradioBulkProgress,
    );
    expect(progressHistory.some((value) => value.includes("8/8") && value.includes("8 catalogued"))).toBe(true);
    expect(declaredBatchSizes.length).toBeGreaterThan(1);
    expect(declaredBatchSizes.reduce((total, size) => total + size, 0)).toBe(8);
    expect(declaredBatchSizes.every((size) => size > 0 && size < 8)).toBe(true);
  } finally {
    await stopBroadcast(host);
  }
});

async function authenticatedHost(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.goto(`${runtime.hostUrl}&autobroadcast=0`);
  await expect(page.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
  return page;
}

async function startFreshBroadcast(host: Page): Promise<void> {
  await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
  await host.goto(`${runtime.hostUrl.split("#")[0]}#autobroadcast=0`);
  await host.getByRole("button", { name: /Broadcast/ }).click();
  await host.getByTestId("start-broadcast").click();
  await expect(host.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
}

async function stopBroadcast(host: Page): Promise<void> {
  await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" })).catch(() => undefined);
  await host.close().catch(() => undefined);
}

function minimalWav(sample: number): Buffer {
  const bytes = Buffer.alloc(46);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(38, 4);
  bytes.write("WAVEfmt ", 8, "ascii");
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(8_000, 24);
  bytes.writeUInt32LE(16_000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36, "ascii");
  bytes.writeUInt32LE(2, 40);
  bytes.writeInt16LE(sample, 44);
  return bytes;
}
