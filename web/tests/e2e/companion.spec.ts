import fs from "node:fs";

import { expect, test, type Page } from "@playwright/test";

interface RuntimeFile {
  hostUrl: string;
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeFile;
const passwordPath = process.env.ZURADIO_TEST_PASSWORD_FILE;
if (!passwordPath) throw new Error("ZURADIO_TEST_PASSWORD_FILE must name the daemon password file");
const password = fs.readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");
const initialTrackCount = process.env.ZURADIO_FORMAT_FIXTURES === "1" ? 8 : 3;
const companionBase = process.env.ZURADIO_COMPANION_BASE ?? "http://127.0.0.1:4173";

test("streams from the laptop while enforcing listener and controller roles", async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  watch(host, "host", errors);

  try {
    await host.goto(runtime.hostUrl);
    await expect(host.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
    await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
    await host.reload();
    await expect(host.locator("[data-track-row]")).toHaveCount(initialTrackCount);
    const hostRows = host.locator("[data-track-row]");
    const firstTitle = (await hostRows.nth(0).locator(".track-title strong").textContent()) ?? "";
    const secondTitle = (await hostRows.nth(1).locator(".track-title strong").textContent()) ?? "";
    await host.locator("[data-track-row]").first().getByRole("button", { name: /^Play / }).click();
    await expect(host.getByTestId("now-title")).toHaveText(firstTitle);
    await host.getByRole("button", { name: /Broadcast/ }).click();
    await host.getByTestId("start-broadcast").click();
    await expect(host.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
    const listenerContext = await browser.newContext();
    const listener = await listenerContext.newPage();
    watch(listener, "listener", errors);
    await listener.goto(companionBase);
    await listener.setViewportSize({ width: 390, height: 844 });
    await listener.getByTestId("connect-listen").click();
    await expect(listener.getByLabel("Remote player controls")).toHaveCount(0);
    await expect(listener.getByRole("navigation", { name: "Controller sections" })).toHaveCount(0);
    await listener.getByTestId("password").fill(password);
    await listener.getByTestId("connect").click();
    await expect(listener.getByText("Listening live", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(listener.getByText(/Listen access is read-only/)).toBeVisible();
    await expect(listener.getByTestId("companion-visualizer")).toBeVisible();
    await expect(listener.getByTestId("companion-title")).toHaveText(firstTitle, { timeout: 20_000 });
    await listener.waitForFunction(() => {
      const audio = document.querySelector<HTMLAudioElement>('audio[aria-label="Live Zuradio audio"]');
      return Boolean(audio?.srcObject && (audio.srcObject as MediaStream).getAudioTracks().length === 1);
    });

    const controllerContext = await browser.newContext();
    const controller = await controllerContext.newPage();
    watch(controller, "controller", errors);
    await controller.goto(companionBase);
    await controller.setViewportSize({ width: 390, height: 844 });
    await controller.getByTestId("connect-control").click();
    await controller.getByTestId("password").fill(password);
    await controller.getByTestId("connect").click();
    await expect(controller.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    await expect(controller.getByTestId("companion-visualizer")).toBeVisible();
    await expect(controller.locator(".controller-panel .track-row")).toHaveCount(initialTrackCount);
    const remotePlayPause = controller.getByTestId("remote-play-pause");
    if ((await remotePlayPause.textContent()) === "Play") {
      await remotePlayPause.click();
      await expect(host.getByTestId("play-pause")).toHaveAttribute("aria-label", "Pause");
    }
    await expect(remotePlayPause).toHaveText("Pause");

    await remotePlayPause.click();
    await expect(remotePlayPause).toHaveText("Play");
    await expect(host.getByTestId("play-pause")).toHaveAttribute("aria-label", "Play");
    await remotePlayPause.click();
    await expect(host.getByTestId("play-pause")).toHaveAttribute("aria-label", "Pause");

    await controller.getByRole("searchbox", { name: "Search library" }).fill("Arpent");
    await expect(controller.locator(".controller-panel .track-row")).toHaveCount(1);
    await controller.getByRole("button", { name: "Play Arpent" }).click();
    await expect(host.getByTestId("now-title")).toHaveText("Arpent");
    await expect(listener.getByTestId("companion-title")).toHaveText("Arpent");
    await controller.getByTestId("remote-play-pause").click();
    await expect(controller.getByTestId("remote-play-pause")).toHaveText("Play");

    const favorite = controller.getByRole("button", { name: /favorites/ });
    const favoriteLabel = await favorite.getAttribute("aria-label");
    await favorite.click();
    await expect(favorite).toHaveAttribute(
      "aria-label",
      favoriteLabel === "Add to favorites" ? "Remove from favorites" : "Add to favorites",
    );
    await favorite.click();

    const volume = controller.getByRole("slider", { name: "Laptop volume" });
    const originalVolume = await volume.inputValue();
    await volume.fill("41");
    await expect(host.getByTestId("volume")).toHaveValue("41");
    await controller.getByRole("button", { name: "Mute", exact: true }).click();
    await expect(host.getByRole("button", { name: "Unmute" })).toBeVisible();
    await controller.getByRole("button", { name: "Unmute", exact: true }).click();
    const hostShuffle = host.getByRole("button", { name: "Shuffle" });
    const initialShuffle = (await hostShuffle.getAttribute("aria-pressed")) === "true";
    await controller.getByRole("button", { name: "Shuffle", exact: true }).click();
    await expect(hostShuffle).toHaveAttribute("aria-pressed", String(!initialShuffle));
    await controller.getByRole("button", { name: "Shuffle", exact: true }).click();
    await expect(hostShuffle).toHaveAttribute("aria-pressed", String(initialShuffle));

    const initialRepeatLabel = await host.locator('[aria-label^="Repeat mode:"]').getAttribute("aria-label");
    const initialRepeat = initialRepeatLabel?.replace("Repeat mode: ", "") ?? "off";
    const repeatModes = ["off", "all", "one"];
    let repeatMode = initialRepeat;
    for (let index = 0; index < repeatModes.length; index += 1) {
      await controller.getByRole("button", { name: `Repeat mode: ${repeatMode}` }).click();
      repeatMode = repeatModes[(repeatModes.indexOf(repeatMode) + 1) % repeatModes.length] ?? "off";
      await expect(host.getByRole("button", { name: `Repeat mode: ${repeatMode}` })).toBeVisible();
    }
    await controller.getByRole("slider", { name: "Seek position" }).fill("1000");
    await expect(host.getByTestId("seek")).toHaveValue("1000");
    await volume.fill(originalVolume);

    if (initialShuffle) {
      await controller.getByRole("button", { name: "Shuffle", exact: true }).click();
      await expect(hostShuffle).toHaveAttribute("aria-pressed", "false");
    }
    await controller.getByRole("button", { name: "Queue", exact: true }).click();
    const clearQueue = controller.locator(".controller-panel").getByRole("button", { name: "Clear", exact: true });
    if (await clearQueue.isEnabled()) await clearQueue.click();
    await controller.getByRole("button", { name: "Library", exact: true }).click();
    await controller.getByRole("searchbox", { name: "Search library" }).fill("");
    const controllerRows = controller.locator(".controller-panel .track-row");
    await controllerRows.nth(0).getByRole("button", { name: /Add .* to queue/ }).click();
    await controllerRows.nth(1).getByRole("button", { name: /Add .* to queue/ }).click();
    await controllerRows.nth(2).getByRole("button", { name: /Add .* to queue/ }).click();
    await controllerRows.nth(0).getByRole("button", { name: `Play ${firstTitle}` }).click();
    await controller.getByRole("button", { name: "Next", exact: true }).click();
    await expect(host.getByTestId("now-title")).toHaveText(secondTitle);
    await controller.getByRole("button", { name: "Previous", exact: true }).click();
    await expect(host.getByTestId("now-title")).toHaveText(firstTitle);
    await controller.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(host.getByTestId("play-pause")).toHaveAttribute("aria-label", "Play");

    await controller.getByRole("button", { name: "Queue", exact: true }).click();
    const remoteQueue = controller.locator(".controller-panel .queue-item");
    await expect(remoteQueue).toHaveCount(3);
    const lastTitle = (await remoteQueue.last().locator("strong").textContent()) ?? "";
    await remoteQueue.last().getByRole("button", { name: `Move ${lastTitle} up` }).click();
    await expect(remoteQueue.nth(1).locator("strong")).toHaveText(lastTitle);
    const removeTitle = (await remoteQueue.last().locator("strong").textContent()) ?? "";
    await remoteQueue.last().getByRole("button", { name: `Remove ${removeTitle} from queue` }).click();
    await expect(remoteQueue).toHaveCount(2);
    await clearQueue.click();
    await expect(remoteQueue).toHaveCount(0);
    if (initialShuffle) {
      await controller.getByRole("button", { name: "Shuffle", exact: true }).click();
      await expect(hostShuffle).toHaveAttribute("aria-pressed", "true");
    }

    const playlistName = `Remote Test ${Date.now()}`;
    const renamedPlaylist = `${playlistName} Renamed`;
    await controller.getByRole("button", { name: "Playlists", exact: true }).click();
    await controller.getByRole("textbox", { name: "New playlist name" }).fill(playlistName);
    await controller.getByRole("button", { name: "Create", exact: true }).click();
    await expect(controller.locator(".playlist-card").filter({ hasText: playlistName })).toBeVisible();
    await controller.getByRole("button", { name: "Add tracks", exact: true }).click();
    const pickerRows = controller.locator(".playlist-track-picker li");
    await pickerRows.nth(0).getByRole("button", { name: "Add", exact: true }).click();
    await pickerRows.nth(1).getByRole("button", { name: "Add", exact: true }).click();
    const closePicker = controller.getByRole("button", { name: "Close track picker", exact: true });
    const touchTarget = await closePicker.boundingBox();
    expect(touchTarget?.height ?? 0).toBeGreaterThanOrEqual(44);
    await closePicker.click();
    const playlistItems = controller.locator(".playlist-tracks li");
    await expect(playlistItems).toHaveCount(2);
    await playlistItems.nth(1).getByRole("button", { name: / up$/ }).click();
    await playlistItems.nth(0).getByRole("button", { name: /Remove .* from playlist/ }).click();
    await expect(playlistItems).toHaveCount(1);
    await controller.getByRole("button", { name: "Rename", exact: true }).click();
    await controller.locator("[data-rename-playlist]").fill(renamedPlaylist);
    await controller.getByRole("button", { name: "Save name", exact: true }).click();
    await expect(controller.locator(".playlist-card").filter({ hasText: renamedPlaylist })).toBeVisible();
    controller.once("dialog", (dialog) => dialog.accept());
    await controller.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(controller.locator(".playlist-card").filter({ hasText: renamedPlaylist })).toHaveCount(0);

    await controller.screenshot({ path: "test-results/mobile-controller.png", fullPage: true });
    await listener.screenshot({ path: "test-results/mobile-listener.png", fullPage: true });

    await controller.getByRole("button", { name: "Disconnect", exact: true }).click();
    await listener.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(controller.getByTestId("connect-control")).toBeVisible();
    await expect(listener.getByTestId("connect-listen")).toBeVisible();
    expect(errors, "browser page and console errors").toEqual([]);
  } finally {
    await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" })).catch(() => undefined);
    await host.close().catch(() => undefined);
  }
});

function watch(page: Page, label: string, errors: string[]): void {
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label}: ${message.text()}`);
  });
}
