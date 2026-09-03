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
const MAX_CONNECT_LATENCY_MS = 15_000;
const MAX_COMMAND_RTT_MS = 2_000;

test("streams from the laptop while enforcing listener and controller roles", async ({ browser }) => {
  test.setTimeout(180_000);
  const errors: string[] = [];
  const hostContext = await browser.newContext();
  const host = await hostContext.newPage();
  watch(host, "host", errors);

  try {
    await host.goto(`${runtime.hostUrl}&autobroadcast=0`);
    await expect(host.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
    await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
    await host.goto(`${runtime.hostUrl.split("#")[0]}#autobroadcast=0`);
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
    const listenerConnectStarted = Date.now();
    await listener.getByTestId("connect").click();
    await expect(listener.getByText("Listening live", { exact: true })).toBeVisible({ timeout: 45_000 });
    const listenerConnectMs = Date.now() - listenerConnectStarted;
    expect(listenerConnectMs, "listener password-to-live latency").toBeLessThan(MAX_CONNECT_LATENCY_MS);
    await expect(listener.getByText(/Listen access is read-only/)).toBeVisible();
    await expect(listener.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
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
    const controllerConnectStarted = Date.now();
    await controller.getByTestId("connect").click();
    await expect(controller.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    const controllerConnectMs = Date.now() - controllerConnectStarted;
    expect(controllerConnectMs, "controller password-to-ready latency").toBeLessThan(MAX_CONNECT_LATENCY_MS);
    const trustedDevice = await controller.evaluate((rawPassword) => {
      const raw = localStorage.getItem("zuradio.trusted-browser.v1") ?? "";
      const stored = raw ? (JSON.parse(raw) as { deviceId?: string; expiresAt?: number }) : {};
      return {
        hasDeviceId: typeof stored.deviceId === "string" && stored.deviceId.length > 0,
        expiresAt: stored.expiresAt ?? 0,
        containsPassword: raw.includes(rawPassword),
      };
    }, password);
    expect(trustedDevice.hasDeviceId).toBe(true);
    expect(trustedDevice.containsPassword).toBe(false);
    expect(trustedDevice.expiresAt - Date.now()).toBeGreaterThan(23 * 60 * 60 * 1_000);
    expect(trustedDevice.expiresAt - Date.now()).toBeLessThanOrEqual(24 * 60 * 60 * 1_000);
    await expect(controller.getByTestId("companion-visualizer")).toBeVisible();
    await expect(controller.locator(".controller-panel .track-row")).toHaveCount(initialTrackCount);
    await expect(controller.locator(".companion-cover")).toBeVisible();
    await expect(controller.getByRole("navigation", { name: "Access mode" })).toBeVisible();
    const mobileLayout = await controller.evaluate(() => {
      const navigation = document.querySelector<HTMLElement>('.controller-panel nav[aria-label="Controller sections"]')?.getBoundingClientRect();
      const firstButton = document.querySelector<HTMLElement>('.controller-panel nav[aria-label="Controller sections"] button')?.getBoundingClientRect();
      const modeButton = document.querySelector<HTMLElement>('.mode-switcher button')?.getBoundingClientRect();
      const cover = document.querySelector<HTMLElement>(".companion-cover")?.getBoundingClientRect();
      return {
        navigationAtBottom: Boolean(navigation && Math.abs(navigation.bottom - window.innerHeight) <= 2),
        navigationTouchTarget: firstButton?.height ?? 0,
        modeTouchTarget: modeButton?.height ?? 0,
        coverWidth: cover?.width ?? 0,
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(mobileLayout.navigationAtBottom).toBe(true);
    expect(mobileLayout.navigationTouchTarget).toBeGreaterThanOrEqual(44);
    expect(mobileLayout.modeTouchTarget).toBeGreaterThanOrEqual(44);
    expect(mobileLayout.coverWidth).toBeGreaterThanOrEqual(88);
    expect(mobileLayout.noHorizontalOverflow).toBe(true);
    await controller.screenshot({ path: "test-results/mobile-controller-library.png", fullPage: true });

    await controller.setViewportSize({ width: 1440, height: 900 });
    const desktopLayout = await controller.evaluate(() => {
      const player = document.querySelector<HTMLElement>(".companion-player")?.getBoundingClientRect();
      const controller = document.querySelector<HTMLElement>(".controller-panel")?.getBoundingClientRect();
      return {
        ordered: Boolean(player && controller && player.right <= controller.left),
        noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    expect(desktopLayout).toEqual({ ordered: true, noHorizontalOverflow: true });
    await controller.screenshot({ path: "test-results/desktop-controller.png", fullPage: true });
    await controller.setViewportSize({ width: 390, height: 844 });

    const switchToUploadStarted = Date.now();
    await controller.getByTestId("switch-upload").click();
    await expect(controller.getByText("Upload connected", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(controller.locator("main")).toHaveAttribute("aria-busy", "false");
    const switchToUploadMs = Date.now() - switchToUploadStarted;
    expect(switchToUploadMs, "control-to-upload switch latency").toBeLessThan(MAX_CONNECT_LATENCY_MS);
    await expect(controller.getByTestId("switch-upload")).toHaveAttribute("aria-current", "page");
    await expect(controller.getByRole("heading", { name: "Add music to this laptop" })).toBeVisible();
    await expect(controller.getByRole("button", { name: "Chat", exact: true })).toHaveCount(0);
    await expect(controller.getByRole("dialog")).toHaveCount(0);
    await controller.screenshot({ path: "test-results/mobile-upload-mode.png", fullPage: true });

    const switchToControlStarted = Date.now();
    await controller.getByTestId("switch-control").click();
    await expect(controller.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 20_000 });
    await expect(controller.locator("main")).toHaveAttribute("aria-busy", "false");
    const switchToControlMs = Date.now() - switchToControlStarted;
    expect(switchToControlMs, "upload-to-control switch latency").toBeLessThan(MAX_CONNECT_LATENCY_MS);
    await expect(controller.getByTestId("switch-control")).toHaveAttribute("aria-current", "page");
    await expect(controller.getByLabel("Remote player controls")).toBeVisible();
    await expect(controller.getByRole("dialog")).toHaveCount(0);

    await host.locator('[data-action="nav"][data-view="chat"]').click();
    const clearExistingChat = host.getByTestId("clear-chat");
    if (await clearExistingChat.isVisible()) {
      host.once("dialog", (dialog) => dialog.accept());
      await clearExistingChat.click();
      await expect(host.getByTestId("chat-message")).toHaveCount(0);
    }
    await controller.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(controller.getByTestId("remote-chat")).toBeVisible();
    const remoteMessage = `Remote hello ${Date.now()}`;
    await controller.getByTestId("remote-chat-input").fill(remoteMessage);
    const hostMuteForDraftTest = host.getByRole("button", { name: "Mute", exact: true });
    await hostMuteForDraftTest.click();
    await expect(controller.getByTestId("remote-chat-input")).toHaveValue(remoteMessage);
    await expect(controller.getByTestId("remote-chat-input")).toBeFocused();
    await host.getByRole("button", { name: "Unmute", exact: true }).click();
    await expect(controller.getByTestId("remote-chat-input")).toHaveValue(remoteMessage);
    const chatCommandStarted = Date.now();
    await controller.getByTestId("remote-chat-send").click();
    await expect(host.getByTestId("host-chat").getByText(remoteMessage, { exact: true })).toBeVisible();
    await expect(controller.getByTestId("remote-chat").getByText(remoteMessage, { exact: true })).toBeVisible();
    const chatCommandRttMs = Date.now() - chatCommandStarted;
    expect(chatCommandRttMs, "remote chat acknowledgement latency").toBeLessThan(MAX_COMMAND_RTT_MS);
    await expect(host.locator('[data-testid="chat-message"][data-sender="remote"]')).toContainText(remoteMessage);

    const oversizedUtf8Message = "🙂".repeat(16_385);
    await controller.getByTestId("remote-chat-input").fill(oversizedUtf8Message);
    await expect(controller.getByTestId("remote-chat-count")).toHaveText(
      "16,385 / 65,536 characters · 65,540 / 65,536 UTF-8 bytes",
    );
    await expect(controller.getByTestId("remote-chat-send")).toBeDisabled();

    const longRemoteMessage = (`Remote long plan\n${"checkpoint line\n".repeat(5_000)}`).slice(0, 65_535) + "Z";
    expect(new TextEncoder().encode(longRemoteMessage)).toHaveLength(65_536);
    await controller.getByTestId("remote-chat-input").fill(longRemoteMessage);
    await expect(controller.getByTestId("remote-chat-count")).toHaveText(
      "65,536 / 65,536 characters · 65,536 / 65,536 UTF-8 bytes",
    );
    const longChatCommandStarted = Date.now();
    await controller.getByTestId("remote-chat-send").click();
    const hostLongMessage = host.locator('[data-testid="chat-message"][data-sender="remote"]').last().locator("p");
    await expect(hostLongMessage).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(
      () => hostLongMessage.evaluate((node, expected) => node.textContent === expected, longRemoteMessage),
      { timeout: 20_000 },
    ).toBe(true);
    const controllerLongMessage = controller.locator('[data-testid="chat-message"][data-sender="remote"]').last().locator("p");
    await expect(controllerLongMessage).toHaveCount(1, { timeout: 20_000 });
    expect(await controllerLongMessage.evaluate((node, expected) => node.textContent === expected, longRemoteMessage)).toBe(true);
    await expect(hostLongMessage).toHaveCSS("white-space", "pre-wrap");
    const longChatCommandRttMs = Date.now() - longChatCommandStarted;
    expect(longChatCommandRttMs, "64 KiB remote chat acknowledgement latency").toBeLessThan(MAX_COMMAND_RTT_MS);

    const markupMessage = `<img src=x onerror="window.__zuradioChatExecuted=true">`;
    await controller.getByTestId("remote-chat-input").fill(markupMessage);
    await controller.getByTestId("remote-chat-send").click();
    await expect(host.getByTestId("host-chat").getByText(markupMessage, { exact: true })).toBeVisible();
    await expect(host.getByTestId("host-chat").locator("img")).toHaveCount(0);
    expect(await host.evaluate(() => (window as Window & { __zuradioChatExecuted?: boolean }).__zuradioChatExecuted)).toBeUndefined();

    const localMessage = (`Laptop long reply ${Date.now()}\n${"local checkpoint\n".repeat(1_500)}`).slice(0, 20_000);
    await host.getByTestId("host-chat-input").fill(localMessage);
    await expect(host.getByTestId("host-chat-count")).toHaveText(
      "20,000 / 65,536 characters · 20,000 / 65,536 UTF-8 bytes",
    );
    await host.getByTestId("host-chat-send").click();
    const controllerLocalMessage = controller.locator('[data-testid="chat-message"][data-sender="local"]').last().locator("p");
    await expect(controllerLocalMessage).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(
      () => controllerLocalMessage.evaluate((node, expected) => node.textContent === expected, localMessage),
      { timeout: 20_000 },
    ).toBe(true);
    await controller.screenshot({ path: "test-results/mobile-controller-chat.png", fullPage: true });

    host.once("dialog", (dialog) => dialog.accept());
    await host.getByTestId("clear-chat").click();
    await expect(host.getByTestId("chat-message")).toHaveCount(0);
    await expect(controller.getByTestId("chat-message")).toHaveCount(0);
    await controller.getByRole("button", { name: "Library", exact: true }).click();

    const remotePlayPause = controller.getByTestId("remote-play-pause");
    if ((await remotePlayPause.textContent()) === "Play") {
      await remotePlayPause.click();
      await expect(host.getByTestId("play-pause")).toHaveAttribute("aria-label", "Pause");
    }
    await expect(remotePlayPause).toHaveText("Pause");

    const commandStarted = Date.now();
    await remotePlayPause.click();
    await expect(remotePlayPause).toHaveText("Play");
    await expect(host.getByTestId("play-pause")).toHaveAttribute("aria-label", "Play");
    const commandRttMs = Date.now() - commandStarted;
    expect(commandRttMs, "remote command acknowledgement latency").toBeLessThan(MAX_COMMAND_RTT_MS);
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
    await expect(pickerRows.nth(0).getByRole("button", { name: "Added", exact: true })).toBeDisabled();
    await pickerRows.nth(1).getByRole("button", { name: "Add", exact: true }).click();
    await expect(pickerRows.nth(1).getByRole("button", { name: "Added", exact: true })).toBeDisabled();
    const closePicker = controller.getByRole("button", { name: "Close track picker", exact: true });
    await expect(closePicker).toBeVisible();
    await closePicker.scrollIntoViewIfNeeded();
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
    await expect(controller.getByTestId("connect-control")).toBeVisible();
    await expect(controller.getByTestId("trusted-device")).toContainText("Trusted until");
    const trustedController = await controllerContext.newPage();
    watch(trustedController, "trusted-controller", errors);
    await trustedController.goto(companionBase);
    const trustedConnectStarted = Date.now();
    await trustedController.getByTestId("connect-control").click();
    await expect(trustedController.getByRole("dialog")).toHaveCount(0);
    await expect(trustedController.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 20_000 });
    const trustedConnectMs = Date.now() - trustedConnectStarted;
    expect(trustedConnectMs, "trusted-browser passwordless reconnect latency").toBeLessThan(MAX_CONNECT_LATENCY_MS);
    await expect(trustedController.getByLabel("Remote player controls")).toBeVisible();
    const trustedShuffle = trustedController.getByRole("button", { name: "Shuffle", exact: true });
    const trustedShuffleBefore = (await hostShuffle.getAttribute("aria-pressed")) === "true";
    const trustedCommandStarted = Date.now();
    await trustedShuffle.click();
    await expect(hostShuffle).toHaveAttribute("aria-pressed", String(!trustedShuffleBefore));
    const trustedCommandRttMs = Date.now() - trustedCommandStarted;
    expect(trustedCommandRttMs, "trusted-browser command acknowledgement latency").toBeLessThan(MAX_COMMAND_RTT_MS);
    await trustedShuffle.click();
    await expect(hostShuffle).toHaveAttribute("aria-pressed", String(trustedShuffleBefore));
    await trustedController.getByRole("button", { name: "Disconnect", exact: true }).click();
    await trustedController.getByRole("button", { name: "Forget this browser", exact: true }).click();
    await expect(trustedController.getByTestId("trusted-device")).toHaveCount(0);
    await trustedController.getByTestId("connect-control").click();
    await expect(trustedController.getByRole("dialog")).toBeVisible();
    await expect(trustedController.getByTestId("password")).toBeFocused();
    await trustedController.getByRole("button", { name: "Cancel", exact: true }).click();

    await listener.getByRole("button", { name: "Disconnect", exact: true }).click();
    await expect(listener.getByTestId("connect-listen")).toBeVisible();
    await test.info().attach("latency-metrics.json", {
      body: JSON.stringify(
        {
          listenerConnectMs,
          controllerConnectMs,
          switchToUploadMs,
          switchToControlMs,
          chatCommandRttMs,
          longChatCommandRttMs,
          commandRttMs,
          trustedConnectMs,
          trustedCommandRttMs,
        },
        null,
        2,
      ),
      contentType: "application/json",
    });
    expect(errors, "browser page and console errors").toEqual([]);
  } finally {
    await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" })).catch(() => undefined);
    await host.close().catch(() => undefined);
  }
});

test("loads a controller snapshot larger than one bounded WebRTC message", async ({ browser }) => {
  test.setTimeout(150_000);
  const host = await browser.newPage();
  const controllerContext = await browser.newContext();
  const controller = await controllerContext.newPage();
  const playlistPrefix = `Snapshot framing ${Date.now()}`;
  const chatMessages = Array.from({ length: 20 }, (_, index) =>
    `${String(index + 1).padStart(2, "0")} ${"bounded snapshot chat ".repeat(13)}`.slice(0, 300),
  );
  try {
    await host.goto(`${runtime.hostUrl}&autobroadcast=0`);
    await expect(host.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
    await host.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
    await host.goto(`${runtime.hostUrl.split("#")[0]}#autobroadcast=0`);
    const snapshotBytes = await host.evaluate(async ({ messages, prefix }) => {
      const action = async (nextAction: Record<string, unknown>) => {
        const response = await fetch("/api/v1/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: 1,
            commandId: crypto.randomUUID(),
            expectedRevision: null,
            actor: { role: "local", peerId: null },
            action: nextAction,
          }),
        });
        if (!response.ok) throw new Error(`Could not seed large snapshot (${response.status})`);
      };
      await action({ kind: "chat_clear" });
      for (const text of messages) await action({ kind: "chat_post", text });
      for (let index = 0; index < 40; index += 1) {
        await action({ kind: "playlist_create", name: `${prefix} ${String(index).padStart(2, "0")} ${"x".repeat(28)}` });
      }
      const snapshot = await fetch("/api/v1/snapshot", { cache: "no-store" }).then((response) => response.json());
      return new TextEncoder().encode(JSON.stringify(snapshot)).length;
    }, { messages: chatMessages, prefix: playlistPrefix });
    expect(snapshotBytes).toBeGreaterThan(16_384);

    await host.getByRole("button", { name: /Broadcast/ }).click();
    await host.getByTestId("start-broadcast").click();
    await expect(host.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
    await controller.goto(companionBase);
    await controller.getByTestId("connect-control").click();
    await controller.getByTestId("password").fill(password);
    const connectedAt = Date.now();
    await controller.getByTestId("connect").click();
    await expect(controller.getByText("Controller connected", { exact: true })).toBeVisible({ timeout: 45_000 });
    expect(Date.now() - connectedAt, "chunked controller snapshot connection latency").toBeLessThan(
      MAX_CONNECT_LATENCY_MS,
    );
    await expect(controller.locator(".controller-panel .track-row")).toHaveCount(initialTrackCount);
    await controller.getByRole("button", { name: "Chat", exact: true }).click();
    await expect(controller.getByTestId("chat-message")).toHaveCount(chatMessages.length);
    await expect(controller.getByTestId("remote-chat").getByText(chatMessages.at(-1) ?? "", { exact: true })).toBeVisible();
  } finally {
    await host.evaluate(async (prefix) => {
      const snapshot = await fetch("/api/v1/snapshot", { cache: "no-store" }).then((response) => response.json());
      const actions = [
        { kind: "chat_clear" },
        ...snapshot.playlists
          .filter((playlist: { name?: unknown }) => typeof playlist.name === "string" && playlist.name.startsWith(prefix))
          .map((playlist: { id: string }) => ({ kind: "playlist_delete", playlistId: playlist.id })),
      ];
      for (const action of actions) {
        await fetch("/api/v1/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            protocol: 1,
            commandId: crypto.randomUUID(),
            expectedRevision: null,
            actor: { role: "local", peerId: null },
            action,
          }),
        });
      }
      await fetch("/api/v1/broadcast/stop", { method: "POST" });
    }, playlistPrefix).catch(() => undefined);
    await controllerContext.close().catch(() => undefined);
    await host.close().catch(() => undefined);
  }
});

function watch(page: Page, label: string, errors: string[]): void {
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label}: ${message.text()}`);
  });
}
