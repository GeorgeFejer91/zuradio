import { execFile } from "node:child_process";
import fs from "node:fs";
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
    await currentHost.getByTestId("stop-broadcast").click();
    await expect(currentHost.getByTestId("start-broadcast")).toBeVisible();
    await currentHost.getByTestId("start-broadcast").click();
    await expect(currentHost.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
    await expect(staleHost.getByText("A newer Zuradio window replaced this broadcast", { exact: true })).toBeVisible({
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
    const result = JSON.parse(stdout) as {
      status: string;
      source: string;
      selectedFiles: number;
      importedTracks: number;
    };
    expect(result).toMatchObject({
      status: "uploaded",
      source: "files",
      selectedFiles: 1,
      importedTracks: 1,
    });
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
    await uploader.locator("[data-upload-folder]").setInputFiles(fixtureFolder as string);
    await expect(uploader.getByText("3 files selected", { exact: true })).toBeVisible();
    await uploader.screenshot({ path: "test-results/mobile-upload-folder-selection.png", fullPage: true });
    await uploader.getByTestId("upload").click();
    await expect(uploader.getByText(/3 tracks added to the laptop library/)).toBeVisible({ timeout: 180_000 });
    await expect(uploader.locator(".imported-list li")).toHaveCount(3);
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
