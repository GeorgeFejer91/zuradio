import fs from "node:fs";

import { chromium, expect, test, type Page } from "@playwright/test";

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

test("plays laptop audio and selects folders and files for upload", async ({ browser, browserName }, testInfo) => {
  test.skip(!fixture || !fs.existsSync(fixture), "Set ZURADIO_UPLOAD_FIXTURE to a valid audio file");
  test.skip(!fixtureFolder || !fs.existsSync(fixtureFolder), "Set ZURADIO_UPLOAD_FOLDER to an audio folder");
  test.setTimeout(180_000);

  const hostBrowser = await chromium.launch({
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const host = await hostBrowser.newPage();
  const companionContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  const companion = await companionContext.newPage();
  const errors: string[] = [];
  companion.on("pageerror", (error) => errors.push(error.message));

  try {
    await startFreshBroadcast(host);
    await companion.goto(companionBase);
    await companion.getByTestId("connect-listen").click();
    await companion.getByTestId("password").fill(password);
    const listenerStarted = Date.now();
    await companion.getByTestId("connect").click();
    await expect(companion.getByText("Listening live", { exact: true })).toBeVisible({ timeout: 45_000 });
    const listenerConnectMs = Date.now() - listenerStarted;
    expect(listenerConnectMs, `${browserName} listener connection latency`).toBeLessThan(20_000);
    await companion.waitForFunction(() => {
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-label="Live Zuradio audio"]');
      return Boolean(audio?.srcObject && (audio.srcObject as MediaStream).getAudioTracks().length === 1);
    });

    const uploadStarted = Date.now();
    await companion.getByTestId("switch-upload").click();
    await expect(companion.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 30_000 });
    const uploadConnectMs = Date.now() - uploadStarted;
    expect(uploadConnectMs, `${browserName} listen-to-upload latency`).toBeLessThan(20_000);
    await expect(companion.getByRole("dialog")).toHaveCount(0);

    await companion.locator("[data-upload-folder]").setInputFiles(fixtureFolder as string);
    await expect(companion.getByTestId("upload-selection")).toHaveText("3 files selected");
    await companion.locator("[data-upload-files]").setInputFiles(fixture as string);
    await expect(companion.getByTestId("upload-selection")).toHaveText("1 file selected");
    await companion.getByTestId("upload").click();
    await expect(companion.getByText(expectedTitle, { exact: true })).toBeVisible({ timeout: 90_000 });
    await expect(companion.getByTestId("upload-progress")).toContainText("1 track added to the laptop library");
    expect(errors).toEqual([]);
    testInfo.annotations.push({
      type: "browser-compatibility",
      description: `${browserName}: audio ${listenerConnectMs} ms, upload mode ${uploadConnectMs} ms`,
    });
  } finally {
    await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" })).catch(() => undefined);
    await companionContext.close().catch(() => undefined);
    await hostBrowser.close().catch(() => undefined);
  }
});

async function startFreshBroadcast(host: Page): Promise<void> {
  await host.goto(`${runtime.hostUrl}&autobroadcast=0`);
  await expect(host.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
  await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
  await host.goto(`${runtime.hostUrl.split("#")[0]}#autobroadcast=0`);
  await host.getByRole("button", { name: /Broadcast/ }).click();
  await host.getByTestId("start-broadcast").click();
  await expect(host.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
}
