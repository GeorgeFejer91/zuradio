import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";

import type { AppSnapshot } from "../../src/types";

interface RuntimeFile {
  baseUrl: string;
  cliToken: string;
  hostUrl: string;
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeFile;
const passwordPath = process.env.ZURADIO_TEST_PASSWORD_FILE;
if (!passwordPath) throw new Error("ZURADIO_TEST_PASSWORD_FILE must name the daemon password file");
const password = fs.readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");
const fixtureFolder = process.env.ZURADIO_UPLOAD_FOLDER;
const libraryRoot = process.env.ZURADIO_TEST_LIBRARY;
const companionBase = process.env.ZURADIO_COMPANION_BASE ?? "http://127.0.0.1:4173";
const uploadFloorBps = Number(process.env.ZURADIO_UPLOAD_FLOOR_BPS ?? 32 * 1024);
const downloadFloorBps = Number(process.env.ZURADIO_DOWNLOAD_FLOOR_BPS ?? 1_000_000);
const firstCatalogueLimitMs = Number(process.env.ZURADIO_FIRST_CATALOGUE_LIMIT_MS ?? 90_000);
const recognitionLimitMs = Number(process.env.ZURADIO_RECOGNITION_LIMIT_MS ?? 30_000);
const audioExtensions = new Set([
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

test("passes the staged upload, immediate catalogue, organized storage, and download benchmark", async ({
  browser,
}) => {
  test.skip(!fixtureFolder || !fs.existsSync(fixtureFolder), "Set ZURADIO_UPLOAD_FOLDER to an audio folder");
  test.skip(!libraryRoot, "Set ZURADIO_TEST_LIBRARY to the isolated visible library folder");
  test.setTimeout(240_000);

  const uploadPaths = fixtureFiles(fixtureFolder as string).slice(0, 2);
  expect(uploadPaths, "The transfer gate needs two source tracks").toHaveLength(2);
  const sourceDigests = new Map(uploadPaths.map((filePath) => [digestFile(filePath), filePath]));
  const sourceBytes = uploadPaths.reduce((total, filePath) => total + fs.statSync(filePath).size, 0);
  const before = await daemonSnapshot();
  const beforeIds = new Set(before.tracks.map((track) => track.id));
  const host = await authenticatedHost(browser);
  const isolatedLibrary = libraryRoot as string;
  const libraryBackup = `${isolatedLibrary}.preflight-${process.pid}-${Date.now()}`;
  let libraryIsBlocked = false;

  try {
    await startFreshBroadcast(host);
    await host.getByRole("button", { name: /Library/ }).click();
    const hostTrackCount = await host.locator("[data-track-row]").count();
    expect(hostTrackCount).toBe(before.tracks.filter((track) => track.available).length);

    const uploader = await browser.newPage();
    await uploader.addInitScript(() => {
      const labels: string[] = [];
      Object.defineProperty(window, "__zuradioDataChannels", { value: labels });
      const original = RTCPeerConnection.prototype.createDataChannel;
      RTCPeerConnection.prototype.createDataChannel = function (label, options) {
        labels.push(label);
        return original.call(this, label, options);
      };
    });
    await uploader.goto(companionBase);
    await uploader.getByTestId("connect-upload").click();
    await uploader.getByTestId("password").fill(password);
    await uploader.getByTestId("connect").click();
    await expect(uploader.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 45_000 });

    await uploader.locator("[data-upload-files]").setInputFiles(uploadPaths);
    await expect(uploader.getByTestId("upload-selection")).toHaveText("2 files selected");

    fs.renameSync(isolatedLibrary, libraryBackup);
    fs.writeFileSync(isolatedLibrary, "temporary storage-gate blocker");
    libraryIsBlocked = true;
    const progress = uploader.getByTestId("upload-progress");
    const localProgress = host.getByTestId("local-transfer-status");
    try {
      await uploader.getByTestId("upload").click();
      await expect(uploader.getByRole("alert")).toContainText(
        /upload storage is unavailable while (preparing|verifying) the managed library/i,
      );
      await expect(progress).toHaveText("Starting secure transfer · waiting for laptop acknowledgement");
      await expect(localProgress).toContainText("Transfer interrupted");
      await expect(localProgress).toContainText(/upload storage is unavailable while/i);
    } finally {
      restoreBlockedLibrary(isolatedLibrary, libraryBackup);
      libraryIsBlocked = false;
    }

    const uploadStarted = performance.now();
    await uploader.getByTestId("upload").click();
    await expect(localProgress).toContainText("Receiving music from another computer", { timeout: 10_000 });
    await expect.poll(async () => (await progress.textContent()) ?? "", { timeout: 45_000 }).toMatch(/[1-9]\d*%/);
    expect(
      await uploader.evaluate(() => (window as unknown as { __zuradioDataChannels: string[] }).__zuradioDataChannels),
      "audio bytes must use the dedicated binary data channel",
    ).toContain("x-zuradio-upload-v1");
    await expect(localProgress).toContainText(/[1-9]\d*(?:\.\d)? (?:KiB|MiB) \/ /, { timeout: 45_000 });
    await expect(progress).toContainText("1 catalogued on laptop", { timeout: firstCatalogueLimitMs });
    const firstCatalogueMs = Math.round(performance.now() - uploadStarted);
    expect(firstCatalogueMs).toBeLessThan(firstCatalogueLimitMs);
    await expect(host.getByTestId("local-transfer-count")).toHaveText("1 of 2 catalogued");
    await host.screenshot({ path: "test-results/local-transfer-activity.png", fullPage: true });
    await expect.poll(() => host.locator("[data-track-row]").count(), { timeout: 10_000 }).toBeGreaterThan(hostTrackCount);

    await expect(progress).toContainText("2 tracks added to the laptop library", { timeout: 150_000 });
    await expect(uploader.locator(".imported-list li")).toHaveCount(2);
    await expect(localProgress).toContainText("Transfer complete");
    await expect(host.getByTestId("local-transfer-count")).toHaveText("2 of 2 catalogued");
    const uploadMs = Math.max(1, Math.round(performance.now() - uploadStarted));
    const uploadBytesPerSecond = Math.round(sourceBytes / (uploadMs / 1_000));
    expect(uploadBytesPerSecond).toBeGreaterThan(uploadFloorBps);

    await expect
      .poll(async () => newAvailableTracks(beforeIds).then((tracks) => tracks.length), { timeout: 10_000 })
      .toBe(uploadPaths.length);
    await expect
      .poll(
        async () =>
          newAvailableTracks(beforeIds).then(
            (tracks) => tracks.filter((track) => track.recognition.status === "recognized").length,
          ),
        { timeout: recognitionLimitMs },
      )
      .toBe(uploadPaths.length);
    const recognitionMs = Math.round(performance.now() - uploadStarted);
    expect(recognitionMs).toBeLessThan(recognitionLimitMs);
    const newTracks = await newAvailableTracks(beforeIds);
    for (const track of newTracks) {
      expect(track.recognition.label).toBe("Zuradio Test Artist — Verified Acoustic Match");
      expect(track.recognition.title).toBe("Verified Acoustic Match");
      expect(track.recognition.artist).toBe("Zuradio Test Artist");
      expect(track.recognition.album).toBe("Acoustic Verification Collection");
      expect(track.recognition.genre).toBe("Verification Electronica");
      await expect(host.getByTestId(`recognition-${track.id}`)).toContainText(
        "Shazam metadata · Zuradio Test Artist — Verified Acoustic Match · Verification Electronica",
      );
    }
    const recognizedSnapshot = await daemonSnapshot();
    const genreMatches = recognizedSnapshot.tracks.filter(
      (track) => track.available && track.recognition.genre === "Verification Electronica",
    ).length;
    expect(genreMatches).toBeGreaterThanOrEqual(newTracks.length);
    await host.getByTestId("search").fill("Verification Electronica");
    await expect(host.locator("[data-track-row]"), "local search must use the parallel Shazam genre").toHaveCount(genreMatches);
    await host.getByTestId("search").fill("");

    const controller = await browser.newPage();
    await controller.goto(companionBase);
    await controller.getByTestId("connect-control").click();
    await controller.getByTestId("password").fill(password);
    await controller.getByTestId("connect").click();
    await expect(controller.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await controller.getByRole("searchbox", { name: "Search library" }).fill("Acoustic Verification Collection");
    const albumMatches = recognizedSnapshot.tracks.filter(
      (track) => track.available && track.recognition.album === "Acoustic Verification Collection",
    ).length;
    await expect(controller.locator(".music-track-list .track-row"), "remote search must use the parallel Shazam album").toHaveCount(albumMatches);
    await controller.close();

    const downloadStarted = performance.now();
    let downloadedBytes = 0;
    const downloadedDigests = new Set<string>();
    for (const track of newTracks) {
      const response = await fetch(`${runtime.baseUrl}/api/v1/media/${encodeURIComponent(track.id)}`, {
        headers: { Authorization: `Bearer ${runtime.cliToken}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
      const bytes = Buffer.from(await response.arrayBuffer());
      downloadedBytes += bytes.length;
      downloadedDigests.add(createHash("sha256").update(bytes).digest("hex"));
    }
    const downloadMs = Math.max(1, Math.round(performance.now() - downloadStarted));
    const downloadBytesPerSecond = Math.round(downloadedBytes / (downloadMs / 1_000));
    expect(downloadedBytes).toBe(sourceBytes);
    expect(downloadedDigests).toEqual(new Set(sourceDigests.keys()));
    expect(downloadBytesPerSecond).toBeGreaterThan(downloadFloorBps);

    const organizedFiles = recursiveAudioFiles(libraryRoot as string);
    expect(organizedFiles).toHaveLength(uploadPaths.length);
    for (const filePath of organizedFiles) {
      const relative = path.relative(libraryRoot as string, filePath);
      const parts = relative.split(path.sep);
      expect(parts, `${relative} must use Artist/Album/Filename`).toHaveLength(3);
      expect(parts[0]).not.toMatch(/^\.|^Unknown$/);
      expect(parts[1]).not.toMatch(/^\.|^Unknown$/);
      const digest = digestFile(filePath);
      expect(sourceDigests.has(digest), `${relative} must preserve the source bytes`).toBe(true);
      expect(parts[2]).toContain(`[${digest.slice(0, 12)}]`);
    }

    const benchmark = {
      sourceFiles: uploadPaths.length,
      sourceBytes,
      firstCatalogueMs,
      recognitionMs,
      uploadMs,
      uploadBytesPerSecond,
      downloadedBytes,
      downloadMs,
      downloadBytesPerSecond,
      byteExact: true,
      organizedFiles: organizedFiles.length,
    };
    test.info().annotations.push({ type: "data-transfer-benchmark", description: JSON.stringify(benchmark) });
    await test.info().attach("data-transfer-benchmark.json", {
      body: Buffer.from(`${JSON.stringify(benchmark, null, 2)}\n`),
      contentType: "application/json",
    });
    process.stdout.write(`Data transfer benchmark: ${JSON.stringify(benchmark)}\n`);
  } finally {
    if (libraryIsBlocked) restoreBlockedLibrary(isolatedLibrary, libraryBackup);
    await stopBroadcast(host);
  }
});

function restoreBlockedLibrary(library: string, backup: string): void {
  if (fs.existsSync(library) && fs.statSync(library).isFile()) fs.unlinkSync(library);
  if (fs.existsSync(backup)) fs.renameSync(backup, library);
}

async function daemonSnapshot(): Promise<AppSnapshot> {
  const response = await fetch(`${runtime.baseUrl}/api/v1/snapshot`, {
    headers: { Authorization: `Bearer ${runtime.cliToken}` },
  });
  if (!response.ok) throw new Error(`Snapshot request failed with ${response.status}`);
  return (await response.json()) as AppSnapshot;
}

async function newAvailableTracks(beforeIds: Set<string>): Promise<AppSnapshot["tracks"]> {
  const current = await daemonSnapshot();
  return current.tracks.filter((track) => track.available && !beforeIds.has(track.id));
}

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

function fixtureFiles(folder: string): string[] {
  return fs
    .readdirSync(folder)
    .map((name) => path.join(folder, name))
    .filter((filePath) => fs.statSync(filePath).isFile() && audioExtensions.has(path.extname(filePath).toLocaleLowerCase()))
    .sort((left, right) => fs.statSync(left).size - fs.statSync(right).size);
}

function recursiveAudioFiles(folder: string): string[] {
  const files: string[] = [];
  const pending = [folder];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (!directory) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile() && audioExtensions.has(path.extname(entry.name).toLocaleLowerCase())) files.push(entryPath);
    }
  }
  return files.sort();
}

function digestFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}
