import fs from "node:fs";

import { chromium } from "playwright";

const publicUrl = process.env.ZURADIO_PUBLIC_URL ?? "https://georgefejer91.github.io/zuradio/";
const inspectorUrl = process.env.ZURADIO_INSPECTOR_URL ?? "http://127.0.0.1:9224";
const passwordPath = process.env.ZURADIO_TEST_PASSWORD_FILE;
const expectedTracks = Number(process.env.ZURADIO_EXPECTED_TRACKS ?? "3");
const maxConnectMs = 15_000;
const maxCommandMs = 2_000;

if (!passwordPath) throw new Error("ZURADIO_TEST_PASSWORD_FILE must name the installed password file");
const password = fs.readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");

const hostBrowser = await chromium.connectOverCDP(inspectorUrl);
const host = hostBrowser
  .contexts()
  .flatMap((context) => context.pages())
  .find((page) => page.url().startsWith("http://127.0.0.1:"));
if (!host) throw new Error("The inspected Zuradio desktop page is unavailable");

const hostState = await host.evaluate(async () => ({
  hasWebRtc: typeof RTCPeerConnection === "function",
  audioState: new AudioContext().state,
  broadcastActive: Boolean(await (await fetch("/api/v1/broadcast")).json()),
  trackCount: (await (await fetch("/api/v1/snapshot")).json()).tracks.length,
}));
if (!hostState.hasWebRtc) throw new Error("The installed desktop shell has no WebRTC engine");
if (hostState.audioState !== "running") throw new Error("The installed desktop audio graph is autoplay-blocked");
if (!hostState.broadcastActive) throw new Error("The installed app did not broadcast automatically");
if (hostState.trackCount !== expectedTracks) {
  throw new Error(`Expected ${expectedTracks} installed tracks, found ${hostState.trackCount}`);
}

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const errors = [];

try {
  const listenerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const listener = await listenerContext.newPage();
  watch(listener, "listener", errors);
  await listener.goto(publicUrl, { waitUntil: "domcontentloaded" });
  await listener.getByTestId("connect-listen").click();
  await listener.getByTestId("password").fill(password);
  const listenerStarted = performance.now();
  await listener.getByTestId("connect").click();
  await listener.getByText("Listening live", { exact: true }).waitFor({ timeout: 45_000 });
  const listenerConnectMs = Math.round(performance.now() - listenerStarted);
  assertBelow("listener password-to-live", listenerConnectMs, maxConnectMs);
  await listener.waitForFunction(() => {
    const audio = document.querySelector('audio[aria-label="Live Zuradio audio"]');
    return Boolean(audio?.srcObject && audio.srcObject.getAudioTracks().length === 1);
  });

  const controllerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const controller = await controllerContext.newPage();
  watch(controller, "controller", errors);
  await controller.goto(publicUrl, { waitUntil: "domcontentloaded" });
  await controller.getByTestId("connect-control").click();
  await controller.getByTestId("password").fill(password);
  const controllerStarted = performance.now();
  await controller.getByTestId("connect").click();
  await controller.getByText("Controller connected", { exact: true }).waitFor({ timeout: 45_000 });
  const controllerConnectMs = Math.round(performance.now() - controllerStarted);
  assertBelow("controller password-to-ready", controllerConnectMs, maxConnectMs);
  const trackRows = controller.locator(".controller-panel .track-row");
  if ((await trackRows.count()) !== expectedTracks) {
    throw new Error(`Public controller expected ${expectedTracks} tracks, found ${await trackRows.count()}`);
  }

  await controller.getByRole("searchbox", { name: "Search library" }).fill("Arpent");
  await controller.getByRole("button", { name: "Play Arpent" }).click();
  await host.waitForFunction(
    () => document.querySelector('[data-testid="now-title"]')?.textContent === "Arpent",
  );
  await listener.waitForFunction(
    () => document.querySelector('[data-testid="companion-title"]')?.textContent === "Arpent",
    undefined,
    { timeout: 10_000 },
  );

  const remotePlayPause = controller.getByTestId("remote-play-pause");
  const commandStarted = performance.now();
  await remotePlayPause.click();
  await host.waitForFunction(
    () => document.querySelector('[data-testid="play-pause"]')?.getAttribute("aria-label") === "Play",
  );
  const commandRttMs = Math.round(performance.now() - commandStarted);
  assertBelow("remote command acknowledgement", commandRttMs, maxCommandMs);
  await remotePlayPause.click();
  await host.waitForFunction(
    () => document.querySelector('[data-testid="play-pause"]')?.getAttribute("aria-label") === "Pause",
  );

  await controller.getByRole("button", { name: "Disconnect", exact: true }).click();
  await controller.getByTestId("connect-control").waitFor();
  const trustedController = await controllerContext.newPage();
  watch(trustedController, "trusted-controller", errors);
  await trustedController.goto(publicUrl, { waitUntil: "domcontentloaded" });
  const trustedStarted = performance.now();
  await trustedController.getByTestId("connect-control").click();
  if ((await trustedController.getByRole("dialog").count()) !== 0) {
    throw new Error("Trusted browser unexpectedly requested the Zuradio password");
  }
  await trustedController.getByText("Controller connected", { exact: true }).waitFor({ timeout: 20_000 });
  const trustedConnectMs = Math.round(performance.now() - trustedStarted);
  assertBelow("trusted-browser passwordless reconnect", trustedConnectMs, maxConnectMs);
  if ((await trustedController.locator(".controller-panel .track-row").count()) !== expectedTracks) {
    throw new Error("Trusted browser connected without the installed music library");
  }
  const trustedCommandStarted = performance.now();
  await trustedController.getByTestId("remote-play-pause").click();
  await host.waitForFunction(
    () => document.querySelector('[data-testid="play-pause"]')?.getAttribute("aria-label") === "Play",
  );
  const trustedCommandRttMs = Math.round(performance.now() - trustedCommandStarted);
  assertBelow("trusted-browser command acknowledgement", trustedCommandRttMs, maxCommandMs);
  await trustedController.getByTestId("remote-play-pause").click();
  await host.waitForFunction(
    () => document.querySelector('[data-testid="play-pause"]')?.getAttribute("aria-label") === "Pause",
  );
  await trustedController.getByRole("button", { name: "Disconnect", exact: true }).click();

  if (errors.length > 0) throw new Error(`Browser errors: ${errors.join(" | ")}`);
  process.stdout.write(`${JSON.stringify({
    result: "passed",
    listenerConnectMs,
    controllerConnectMs,
    commandRttMs,
    trustedConnectMs,
    trustedCommandRttMs,
    trackCount: expectedTracks,
    streamTrackReceived: true,
  }, null, 2)}\n`);
} finally {
  await browser.close();
  await hostBrowser.close();
}

function watch(page, label, errors) {
  page.on("pageerror", (error) => errors.push(`${label}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`${label}: ${message.text()}`);
  });
}

function assertBelow(label, actual, limit) {
  if (actual >= limit) throw new Error(`${label} took ${actual} ms; required less than ${limit} ms`);
}
