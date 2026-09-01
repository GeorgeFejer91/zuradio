import fs from "node:fs";

import { expect, test } from "@playwright/test";

interface RuntimeFile {
  baseUrl: string;
  hostUrl: string;
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeFile;

test.describe.configure({ mode: "serial" });

let pageErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") pageErrors.push(message.text());
  });
  await page.goto(runtime.hostUrl);
  await expect(page.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
});

test.afterEach(() => {
  expect(pageErrors, "browser console and page errors").toEqual([]);
});

test("scans, searches, and browses the real local catalog", async ({ page }) => {
  await page.getByTestId("scan-library").click();
  await expect(page.locator("[data-track-row]")).toHaveCount(3);
  await page.getByTestId("search").fill("River");
  await expect(page.locator("[data-track-row]")).toHaveCount(1);
  await expect(page.locator("[data-track-row]").getByText("02-River", { exact: true })).toBeVisible();
  await page.getByTestId("search").fill("");
  await page.getByRole("button", { name: /Albums/ }).click();
  await expect(page.getByRole("heading", { name: "Albums" })).toBeVisible();
  await page.getByRole("button", { name: "Unknown Album", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.locator("[data-track-row]")).toHaveCount(3);
  await page.getByRole("button", { name: /Artists/ }).click();
  await expect(page.getByRole("heading", { name: "Artists" })).toBeVisible();
  await page.getByRole("button", { name: "Unknown Artist", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Library" })).toBeVisible();
  await expect(page.locator("[data-track-row]")).toHaveCount(3);
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
  await expect(playlistItems.nth(0)).toContainText("02-River");
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
  await expect(page.getByTestId("now-title")).toHaveText("01-Sunrise");
  await expect(page.getByTestId("play-pause")).toHaveAttribute("aria-label", "Pause");

  await page.getByTestId("play-pause").click();
  await expect(page.getByTestId("play-pause")).toHaveAttribute("aria-label", "Play");
  await page.getByTestId("play-pause").click();
  await rows.nth(1).getByRole("button", { name: /Add .* to queue/ }).click();
  await rows.nth(2).getByRole("button", { name: /Add .* to queue/ }).click();

  await rows.nth(0).getByRole("button", { name: "Add to favorites" }).click();
  await page.getByRole("button", { name: /Favorites/ }).click();
  const favoriteRow = page.locator("[data-track-row]").filter({ hasText: "01-Sunrise" });
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
  await expect(page.getByTestId("now-title")).not.toHaveText("01-Sunrise");
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

test("creates role-separated broadcast invitations and revokes them", async ({ page }) => {
  test.setTimeout(60_000);
  await page.getByRole("button", { name: /Broadcast/ }).click();
  await page.getByTestId("start-broadcast").click();
  await expect(page.getByTestId("stop-broadcast")).toBeVisible({ timeout: 35_000 });
  const listener = await page.getByTestId("listener-invitation").inputValue();
  const controller = await page.getByTestId("controller-invitation").inputValue();
  expect(listener).toContain("#v=1&role=listener");
  expect(listener).not.toContain("pairingKey=");
  expect(controller).toContain("#v=1&role=controller");
  expect(controller).toContain("pairingKey=");
  expect(new URL(listener).search).toBe("");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: runtime.baseUrl });
  await page.getByTestId("listener-invitation").locator("..").getByRole("button", { name: "Copy" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(listener);
  await page.getByTestId("stop-broadcast").click();
  await expect(page.getByTestId("start-broadcast")).toBeVisible();
});

test("is keyboard reachable and responsive at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("search")).toBeVisible();
  await expect(page.getByRole("button", { name: "Shuffle" })).toBeVisible();
  await expect(page.locator('[aria-label^="Repeat mode:"]')).toBeVisible();
  await expect(page.getByTestId("volume")).toBeVisible();
  await expect(page.locator(".right-panel")).toBeVisible();
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
