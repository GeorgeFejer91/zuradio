import fs from "node:fs";

import { expect, test } from "@playwright/test";

interface RuntimeFile {
  baseUrl: string;
  cliToken: string;
  hostUrl: string;
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeFile;
const initialTrackCount = process.env.ZURADIO_FORMAT_FIXTURES === "1" ? 8 : 3;

test.describe.configure({ mode: "serial" });

let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.goto(`${runtime.hostUrl}&autobroadcast=0`);
  await expect(page.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
});

test.afterEach(() => {
  expect(pageErrors, "browser console and page errors").toEqual([]);
});

test("scans, searches, and browses the real local catalog", async ({ page }) => {
  await page.getByTestId("scan-library").click();
  await expect(page.locator("[data-track-row]")).toHaveCount(initialTrackCount);
  await page.getByTestId("search").fill("Arpent");
  await expect(page.locator("[data-track-row]")).toHaveCount(1);
  await expect(page.locator("[data-track-row]").getByText("Arpent", { exact: true })).toBeVisible();
  await page.getByTestId("search").fill("");
  await page.getByRole("button", { name: /Albums/ }).click();
  await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
  await page.getByRole("button", { name: "Complete Discography", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.locator("[data-track-row]")).toHaveCount(1);
  await page.getByRole("button", { name: /Artists/ }).click();
  await expect(page.getByRole("heading", { name: "Artists" })).toBeVisible();
  await page.getByRole("button", { name: "Alexander Nakarada", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.locator("[data-track-row]")).toHaveCount(1);
});

test("edits track metadata and keeps the override after a rescan", async ({ page }) => {
  await page.getByRole("button", { name: /Library/ }).click();
  const row = page.locator("[data-track-row]").first();
  const originalTitle = (await row.locator(".track-title strong").textContent()) ?? "";
  await row.getByRole("button", { name: /Edit metadata/ }).click();
  await page.getByRole("textbox", { name: "Title" }).fill("Browser Edited Title");
  await page.getByTestId("save-metadata").click();
  await expect(page.locator("[data-track-row]").first()).toContainText("Browser Edited Title");
  await page.getByTestId("scan-library").click();
  await expect(page.locator("[data-track-row]").first()).toContainText("Browser Edited Title");
  await expect(page.locator(".shell")).toHaveAttribute("aria-busy", "false");
  await page.locator("[data-track-row]").first().getByRole("button", { name: /Edit metadata/ }).click();
  await page.getByRole("textbox", { name: "Title" }).fill(originalTitle);
  await page.getByTestId("save-metadata").click();
});

test("creates, renames, populates, reorders, and removes a playlist", async ({ page }) => {
  const playlistName = `Road Test ${Date.now()}`;
  const renamedPlaylist = `${playlistName} Renamed`;
  await page.getByRole("button", { name: /Playlists/ }).click();
  await page.getByTestId("playlist-name").fill(playlistName);
  await page.getByTestId("create-playlist").click();
  await expect(page.locator("button.select-playlist").filter({ hasText: playlistName })).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept(renamedPlaylist));
  await page.getByRole("button", { name: `Rename ${playlistName}` }).click();
  await expect(page.locator("button.select-playlist").filter({ hasText: renamedPlaylist })).toBeVisible();

  await page.getByRole("button", { name: /Library/ }).click();
  const rows = page.locator("[data-track-row]");
  await rows.nth(0).getByRole("button", { name: `Add to ${renamedPlaylist}` }).click();
  await rows.nth(1).getByRole("button", { name: `Add to ${renamedPlaylist}` }).click();
  await page.getByRole("button", { name: /Playlists/ }).click();
  await page.locator("button.select-playlist").filter({ hasText: renamedPlaylist }).click();
  const playlistItems = page.locator(".playlist-layout section .queue-item");
  await expect(playlistItems).toHaveCount(2);
  await playlistItems.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(playlistItems.nth(0)).toContainText("Arpent");
  await playlistItems.nth(0).getByRole("button", { name: "Remove from playlist" }).click();
  await expect(playlistItems).toHaveCount(1);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: `Delete ${renamedPlaylist}` }).click();
  await expect(page.locator("button.select-playlist").filter({ hasText: renamedPlaylist })).toHaveCount(0);
});

test("drives playback, queue, favorite, seek, volume, shuffle, repeat, and history", async ({ page }) => {
  await page.getByRole("button", { name: /Library/ }).click();
  const rows = page.locator("[data-track-row]");
  const clearQueue = page.locator(".right-header").getByRole("button", { name: "Clear" });
  if (await clearQueue.isEnabled()) {
    await clearQueue.click();
    await expect(page.locator(".right-panel .queue-item")).toHaveCount(0);
  }

  const shuffle = page.getByRole("button", { name: "Shuffle" });
  const initialShuffle = (await shuffle.getAttribute("aria-pressed")) === "true";
  if (initialShuffle) {
    await shuffle.click();
    await expect(shuffle).toHaveAttribute("aria-pressed", "false");
  }

  const repeatModes = ["off", "all", "one"];
  const repeat = page.locator('[aria-label^="Repeat mode:"]');
  const initialRepeat = (await repeat.getAttribute("aria-label"))?.replace("Repeat mode: ", "") ?? "off";
  let repeatMode = initialRepeat;
  while (repeatMode !== "off") {
    await page.getByRole("button", { name: `Repeat mode: ${repeatMode}` }).click();
    repeatMode = repeatModes[(repeatModes.indexOf(repeatMode) + 1) % repeatModes.length] ?? "off";
    await expect(page.getByRole("button", { name: `Repeat mode: ${repeatMode}` })).toBeVisible();
  }

  const initiallyMuted = (await page.getByRole("button", { name: "Unmute" }).count()) === 1;
  if (initiallyMuted) await page.getByRole("button", { name: "Unmute" }).click();

  const firstFavorite = rows.nth(0).getByRole("button", { name: /favorites/ });
  const initiallyFavorite = (await firstFavorite.getAttribute("aria-label")) === "Remove from favorites";
  if (initiallyFavorite) {
    await firstFavorite.click();
    await expect(rows.nth(0).getByRole("button", { name: "Add to favorites" })).toBeVisible();
  }

  await rows.nth(0).getByRole("button", { name: /^Play / }).click();
  await expect(page.getByTestId("now-title")).toHaveText("Nomadic Sunset");
  await expect(page.getByTestId("play-pause")).toHaveAttribute("aria-label", "Pause");

  await page.getByTestId("play-pause").click();
  await expect(page.getByTestId("play-pause")).toHaveAttribute("aria-label", "Play");
  await page.getByTestId("play-pause").click();
  await rows.nth(1).getByRole("button", { name: /Add .* to queue/ }).click();
  await rows.nth(2).getByRole("button", { name: /Add .* to queue/ }).click();

  await rows.nth(0).getByRole("button", { name: "Add to favorites" }).click();
  await page.getByRole("button", { name: /Favorites/ }).click();
  const favoriteRow = page.locator("[data-track-row]").filter({ hasText: "Nomadic Sunset" });
  await expect(favoriteRow).toHaveCount(1);
  if (!initiallyFavorite) {
    await favoriteRow.getByRole("button", { name: "Remove from favorites" }).click();
    await expect(favoriteRow).toHaveCount(0);
  }

  const volume = page.getByTestId("volume");
  const initialVolume = await volume.inputValue();
  await volume.fill("42");
  await expect(page.getByTestId("volume")).toHaveValue("42");
  await page.getByRole("button", { name: "Mute" }).click();
  await expect(page.getByRole("button", { name: "Unmute" })).toBeVisible();
  await page.getByRole("button", { name: "Unmute" }).click();

  await shuffle.click();
  await expect(shuffle).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Repeat mode: off" }).click();
  await expect(page.getByRole("button", { name: "Repeat mode: all" })).toBeVisible();

  await page.getByTestId("seek").fill("1000");
  await page.getByRole("button", { name: "Next track" }).click();
  await expect(page.getByTestId("now-title")).not.toHaveText("Nomadic Sunset");
  await page.getByRole("button", { name: "Previous track" }).click();
  await page.getByRole("button", { name: "Stop" }).click();
  await page.getByRole("button", { name: /History/ }).click();
  await expect(page.locator("[data-track-row]")).not.toHaveCount(0);

  if (!initialShuffle) {
    await shuffle.click();
    await expect(shuffle).toHaveAttribute("aria-pressed", "false");
  }
  repeatMode = "all";
  while (repeatMode !== initialRepeat) {
    await page.getByRole("button", { name: `Repeat mode: ${repeatMode}` }).click();
    repeatMode = repeatModes[(repeatModes.indexOf(repeatMode) + 1) % repeatModes.length] ?? "off";
    await expect(page.getByRole("button", { name: `Repeat mode: ${repeatMode}` })).toBeVisible();
  }
  await volume.fill(initialVolume);
  if (initiallyMuted) await page.getByRole("button", { name: "Mute" }).click();
});

test("keeps a laptop seek authoritative over a concurrent update and stale playback snapshots", async ({
  page,
  request,
}) => {
  await page.getByRole("button", { name: /Library/ }).click();
  await page.locator("[data-track-row]").first().getByRole("button", { name: /^Play / }).click();
  await page.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return Boolean(audio && Number.isFinite(audio.duration) && audio.duration > 20 && !audio.paused);
  });

  await page.getByTestId("seek").fill("1000");
  await expect
    .poll(async () => {
      const response = await request.get(`${runtime.baseUrl}/api/v1/snapshot`, {
        headers: { Authorization: `Bearer ${runtime.cliToken}` },
      });
      const state = (await response.json()) as { player: { positionMs: number } };
      return state.player.positionMs;
    })
    .toBe(1000);

  const volume = page.getByTestId("volume");
  const initialVolume = Number(await volume.inputValue());
  const competingVolume: number = initialVolume === 17 ? 18 : 17;
  let injectedConcurrentUpdate = false;
  await page.route("**/api/v1/action", async (route) => {
    const body = route.request().postDataJSON() as { action?: { kind?: string; positionMs?: number } };
    if (
      !injectedConcurrentUpdate &&
      body.action?.kind === "seek" &&
      body.action.positionMs === 10_000
    ) {
      injectedConcurrentUpdate = true;
      const snapshotResponse = await request.get(`${runtime.baseUrl}/api/v1/snapshot`, {
        headers: { Authorization: `Bearer ${runtime.cliToken}` },
      });
      const state = (await snapshotResponse.json()) as { revision: number };
      const competingResponse = await request.post(`${runtime.baseUrl}/api/v1/action`, {
        headers: { Authorization: `Bearer ${runtime.cliToken}` },
        data: {
          protocol: 1,
          commandId: crypto.randomUUID(),
          expectedRevision: state.revision,
          actor: { role: "local", peerId: null },
          action: { kind: "set_volume", volume: competingVolume },
        },
      });
      expect(competingResponse.ok(), "competing state update must be accepted").toBe(true);
    }
    await route.continue();
  });

  await page.getByTestId("seek").fill("10000");
  expect(injectedConcurrentUpdate).toBe(true);
  await expect
    .poll(async () => {
      const response = await request.get(`${runtime.baseUrl}/api/v1/snapshot`, {
        headers: { Authorization: `Bearer ${runtime.cliToken}` },
      });
      const state = (await response.json()) as { player: { positionMs: number } };
      return state.player.positionMs;
    })
    .toBe(10_000);
  await expect
    .poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(9.5);

  await expect
    .poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(12.75);
  const beforeUnrelatedUpdate = await page
    .locator("audio")
    .evaluate((element: HTMLAudioElement) => element.currentTime);
  const finalVolume = 23;
  await volume.fill(String(finalVolume));
  await expect
    .poll(() => page.locator("audio").evaluate((element: HTMLAudioElement) => element.currentTime))
    .toBeGreaterThan(beforeUnrelatedUpdate - 0.75);

  await volume.fill(String(initialVolume));
});

test("moves and clears the queue", async ({ page }) => {
  await page.getByRole("button", { name: /Library/ }).click();
  const rows = page.locator("[data-track-row]");
  await rows.nth(0).getByRole("button", { name: /Add .* to queue/ }).click();
  const queue = page.locator(".right-panel .queue-item");
  const count = await queue.count();
  expect(count).toBeGreaterThan(1);
  await queue.last().getByRole("button", { name: "Move up" }).click();
  await queue.last().getByRole("button", { name: "Remove from queue" }).click();
  await page.locator(".right-header").getByRole("button", { name: "Clear" }).click();
  await expect(page.locator(".right-panel .queue-item")).toHaveCount(0);
});

test("starts password discovery without exposing invitation URLs and revokes it", async ({ page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
  await page.goto(`${runtime.baseUrl}/host/#autobroadcast=0`);
  await page.getByRole("button", { name: /Broadcast/ }).click();
  await page.getByTestId("start-broadcast").click();
  await expect(page.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
  await expect(page.getByTestId("access-modes")).toContainText("Listen");
  await expect(page.getByTestId("access-modes")).toContainText("Control");
  await expect(page.getByTestId("access-modes")).toContainText("Upload");
  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByText(/invitation/i)).toHaveCount(0);
  await page.getByTestId("stop-broadcast").click();
  await expect(page.getByTestId("start-broadcast")).toBeVisible();
});

test("keeps the discovery beacon ready without changing playback", async ({ page }) => {
  test.setTimeout(60_000);
  await page.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
  await page.goto(`${runtime.baseUrl}/host/`);
  await expect(page.getByRole("button", { name: /Broadcast On/ })).toBeVisible({ timeout: 35_000 });
  await page.getByRole("button", { name: /Broadcast On/ }).click();
  await expect(page.getByText("Discoverable", { exact: true })).toBeVisible({ timeout: 35_000 });
  await expect(page.getByText(/Music plays only when a player command starts it/)).toBeVisible();
  await expect(page.getByTestId("restart-broadcast")).toBeVisible();
  await expect(page.getByTestId("stop-broadcast")).toHaveCount(0);

  const before = await page.evaluate(async () => ({
    broadcast: await fetch("/api/v1/broadcast").then((response) => response.json()),
    playerStatus: await fetch("/api/v1/snapshot").then((response) => response.json()).then((state) => state.player.status),
  }));
  await page.evaluate(() => fetch("/api/v1/broadcast/stop", { method: "POST" }));
  await expect
    .poll(
      () => page.evaluate(() => fetch("/api/v1/broadcast").then((response) => response.json())),
      { timeout: 35_000 },
    )
    .not.toBeNull();
  const after = await page.evaluate(async () => ({
    broadcast: await fetch("/api/v1/broadcast").then((response) => response.json()),
    playerStatus: await fetch("/api/v1/snapshot").then((response) => response.json()).then((state) => state.player.status),
  }));
  expect(after.broadcast.sessionId).not.toBe(before.broadcast.sessionId);
  expect(after.playerStatus).toBe(before.playerStatus);
  await expect(page.getByText("Discoverable", { exact: true })).toBeVisible();
});

test("is keyboard reachable and responsive at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${runtime.baseUrl}/host/#autobroadcast=0`);
  await expect(page.locator(".track-table-head")).toBeVisible();
  const desktopLayout = await page.evaluate(() => {
    const sidebar = document.querySelector<HTMLElement>(".sidebar")?.getBoundingClientRect();
    const content = document.querySelector<HTMLElement>(".content")?.getBoundingClientRect();
    const queue = document.querySelector<HTMLElement>(".right-panel")?.getBoundingClientRect();
    const player = document.querySelector<HTMLElement>(".player")?.getBoundingClientRect();
    return {
      ordered: Boolean(sidebar && content && queue && sidebar.right <= content.left && content.right <= queue.left),
      playerAtBottom: Boolean(player && Math.abs(player.bottom - window.innerHeight) <= 2),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  expect(desktopLayout).toEqual({ ordered: true, playerAtBottom: true, noHorizontalOverflow: true });
  await page.screenshot({ path: "test-results/desktop-host.png", fullPage: true });

  await page.setViewportSize({ width: 1050, height: 740 });
  await page.goto(`${runtime.baseUrl}/host/#autobroadcast=0`);
  await expect(page.locator(".track-album").first()).toBeHidden();
  const mediumLayout = await page.locator("[data-track-row]").first().evaluate((row) => {
    const duration = row.querySelector<HTMLElement>(".track-duration")?.getBoundingClientRect();
    const actions = row.querySelector<HTMLElement>(".track-actions")?.getBoundingClientRect();
    const bounds = row.getBoundingClientRect();
    return {
      controlsSeparated: Boolean(duration && actions && duration.right <= actions.left),
      actionsContained: Boolean(actions && actions.right <= bounds.right),
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  expect(mediumLayout).toEqual({ controlsSeparated: true, actionsContained: true, noHorizontalOverflow: true });
  await page.screenshot({ path: "test-results/medium-host.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${runtime.baseUrl}/host/#autobroadcast=0`);
  await expect(page.getByTestId("search")).toBeVisible();
  await expect(page.getByRole("button", { name: "Shuffle" })).toBeVisible();
  await expect(page.locator('[aria-label^="Repeat mode:"]')).toBeVisible();
  await expect(page.getByTestId("volume")).toBeVisible();
  await expect(page.locator(".right-panel")).toBeVisible();
  await expect(page.locator(".track-cover").first()).toBeVisible();
  const mobileLayout = await page.evaluate(() => {
    const player = document.querySelector<HTMLElement>(".player")?.getBoundingClientRect();
    const primary = document.querySelector<HTMLElement>(".player-primary")?.getBoundingClientRect();
    return {
      playerAtBottom: Boolean(player && Math.abs(player.bottom - window.innerHeight) <= 2),
      primaryTouchTarget: primary?.height ?? 0,
      noHorizontalOverflow: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  expect(mobileLayout.playerAtBottom).toBe(true);
  expect(mobileLayout.primaryTouchTarget).toBeGreaterThanOrEqual(44);
  expect(mobileLayout.noHorizontalOverflow).toBe(true);
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(() => document.activeElement?.tagName);
  expect(["BUTTON", "INPUT"]).toContain(focused);
  await page.screenshot({ path: "test-results/mobile-host.png", fullPage: true });
});

test("serves the host from loopback only", async ({ request }) => {
  const health = await request.get(`${runtime.baseUrl}/api/v1/health`);
  expect(health.ok()).toBeTruthy();
  const unauthenticated = await request.get(`${runtime.baseUrl}/api/v1/snapshot`);
  expect(unauthenticated.status()).toBe(401);
});
