import fs from "node:fs";

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
    await uploader.getByTestId("connect-control").click();
    await uploader.getByTestId("password").fill(password);
    await uploader.getByTestId("connect").click();
    await expect(uploader.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await uploader.getByTestId("switch-upload").click();
    await expect(uploader.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(uploader.getByRole("dialog")).toHaveCount(0);
    await uploader.locator("[data-upload-files]").setInputFiles(fixture as string);
    await expect(uploader.getByText("1 file selected", { exact: true })).toBeVisible();
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

test("selects a folder, ignores non-audio files, and imports every track", async ({ browser }) => {
  test.skip(!fixtureFolder || !fs.existsSync(fixtureFolder), "Set ZURADIO_UPLOAD_FOLDER to an audio folder");
  test.setTimeout(240_000);
  const host = await authenticatedHost(browser);
  try {
    await startFreshBroadcast(host);
    const uploader = await browser.newPage();
    await uploader.goto(companionBase);
    await uploader.getByTestId("connect-upload").click();
    await uploader.getByTestId("password").fill(password);
    await uploader.getByTestId("connect").click();
    await expect(uploader.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await uploader.locator("[data-upload-folder]").setInputFiles(fixtureFolder as string);
    await expect(uploader.getByText("3 files selected", { exact: true })).toBeVisible();
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
