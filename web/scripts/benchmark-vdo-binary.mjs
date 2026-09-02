import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { chromium } from "@playwright/test";

const payloadMiB = positiveInteger(process.env.ZURADIO_BENCHMARK_MIB, 64);
const repetitions = positiveInteger(process.env.ZURADIO_BENCHMARK_RUNS, 3);
const chunkBytes = positiveInteger(process.env.ZURADIO_BENCHMARK_CHUNK_BYTES, 64 * 1024);
const sdkPath = path.resolve("node_modules/@vdoninja/sdk/vdoninja-sdk.js");
const suffix = randomUUID().replaceAll("-", "").slice(0, 20);
const room = `zradiobench${suffix}`;
const streamID = `zradiobenchstream${suffix}`;
const transportKey = randomUUID();
const outputPath = path.resolve(
  process.cwd(),
  process.env.ZURADIO_BENCHMARK_OUTPUT ?? "../target/vdo-binary-benchmark.json",
);

const originServer = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>Zuradio VDO binary benchmark</title>");
});
await new Promise((resolve) => originServer.listen(0, "127.0.0.1", resolve));
const originPort = originServer.address().port;

const browser = await chromium.launch({ headless: true });
try {
  const receiver = await browser.newPage();
  const sender = await browser.newPage();
  await Promise.all([
    receiver.goto(`http://127.0.0.1:${originPort}`),
    sender.goto(`http://127.0.0.1:${originPort}`),
  ]);
  await Promise.all([receiver.addScriptTag({ path: sdkPath }), sender.addScriptTag({ path: sdkPath })]);

  const startedConnecting = performance.now();
  await receiver.evaluate(
    async ({ room, streamID, transportKey }) => {
      const sdk = new VDONinjaSDK({
        host: "wss://wss.vdo.ninja",
        password: transportKey,
        salt: "vdo.ninja",
        autoRecover: false,
        autoRelay: false,
        turnServers: null,
      });
      window.benchmark = { sdk, peer: null, state: null };
      sdk.addEventListener("dataChannelOpen", (event) => {
        window.benchmark.peer ??= event.detail.uuid;
      });
      sdk.addEventListener("channelOpen", (event) => {
        if (event.detail.label !== "x-bulk") return;
        const channel = event.detail.channel;
        channel.binaryType = "arraybuffer";
        channel.onmessage = (message) => {
          const state = window.benchmark.state;
          if (!state || !(message.data instanceof ArrayBuffer)) return;
          const bytes = new Uint8Array(message.data);
          if (bytes.byteLength < 8) {
            state.error = "short frame";
            return;
          }
          const view = new DataView(message.data);
          const sequence = view.getUint32(0);
          const declaredBytes = view.getUint32(4);
          const expected = sequence & 0xff;
          if (
            sequence >= state.totalChunks ||
            declaredBytes !== bytes.byteLength - 8 ||
            state.seen[sequence] !== 0 ||
            bytes[8] !== expected ||
            bytes[bytes.byteLength - 1] !== expected
          ) {
            state.error = `invalid frame ${sequence}`;
            return;
          }
          state.seen[sequence] = 1;
          state.receivedBytes += declaredBytes;
          state.receivedChunks += 1;
          if (state.receivedChunks === state.totalChunks) {
            const byteExact =
              state.error === null &&
              state.receivedBytes === state.payloadBytes &&
              state.seen.every((value) => value === 1);
            sdk.sendData(
              {
                type: "zuradio.benchmark.complete",
                run: state.run,
                receivedBytes: state.receivedBytes,
                byteExact,
              },
              { uuid: event.detail.uuid, allowFallback: false },
            );
          }
        };
      });
      await sdk.connect();
      await sdk.joinRoom({ room, password: transportKey });
      await sdk.announce({ streamID, label: "Zuradio binary benchmark" });
    },
    { room, streamID, transportKey },
  );

  await sender.evaluate(
    async ({ room, streamID, transportKey }) => {
      const sdk = new VDONinjaSDK({
        host: "wss://wss.vdo.ninja",
        password: transportKey,
        salt: "vdo.ninja",
        autoRecover: false,
        autoRelay: false,
        turnServers: null,
      });
      window.benchmark = { sdk, peer: null, completions: new Map() };
      sdk.addEventListener("dataChannelOpen", (event) => {
        window.benchmark.peer ??= event.detail.uuid;
      });
      sdk.addEventListener("dataReceived", (event) => {
        const data = event.detail.data;
        if (data?.type !== "zuradio.benchmark.complete") return;
        const resolve = window.benchmark.completions.get(data.run);
        if (resolve) {
          window.benchmark.completions.delete(data.run);
          resolve(data);
        }
      });
      await sdk.connect();
      await sdk.joinRoom({ room, password: transportKey });
      await sdk.view(streamID, {
        audio: false,
        video: false,
        dataOnly: true,
        downloads: false,
        allowresources: false,
      });
    },
    { room, streamID, transportKey },
  );

  await Promise.all([
    receiver.waitForFunction(() => Boolean(window.benchmark?.peer), null, { timeout: 20_000 }),
    sender.waitForFunction(() => Boolean(window.benchmark?.peer), null, { timeout: 20_000 }),
  ]);
  const connectionMs = performance.now() - startedConnecting;
  const route = await sender.evaluate(() => window.benchmark.sdk.getPeerQuality(window.benchmark.peer));
  const results = [];

  for (let run = 1; run <= repetitions; run += 1) {
    await receiver.evaluate(
      ({ run, payloadBytes, chunkBytes }) => {
        window.benchmark.state = {
          run,
          payloadBytes,
          totalChunks: Math.ceil(payloadBytes / chunkBytes),
          receivedBytes: 0,
          receivedChunks: 0,
          seen: new Uint8Array(Math.ceil(payloadBytes / chunkBytes)),
          error: null,
        };
      },
      { run, payloadBytes: payloadMiB * 1024 * 1024, chunkBytes },
    );

    const result = await sender.evaluate(
      async ({ run, payloadBytes, chunkBytes }) => {
        const { sdk, peer, completions } = window.benchmark;
        const channel = await sdk.openChannel(peer, "bulk", { ordered: true });
        channel.bufferedAmountLowThreshold = 512 * 1024;
        const completion = new Promise((resolve) => completions.set(run, resolve));
        const totalChunks = Math.ceil(payloadBytes / chunkBytes);
        let maxBufferedBytes = 0;
        let bytesSinceYield = 0;
        const started = performance.now();
        for (let sequence = 0; sequence < totalChunks; sequence += 1) {
          while (channel.bufferedAmount > 1024 * 1024) {
            await new Promise((resolve) => {
              const listener = () => {
                channel.removeEventListener("bufferedamountlow", listener);
                resolve();
              };
              channel.addEventListener("bufferedamountlow", listener);
            });
          }
          const offset = sequence * chunkBytes;
          const count = Math.min(chunkBytes, payloadBytes - offset);
          const frame = new Uint8Array(count + 8);
          const view = new DataView(frame.buffer);
          view.setUint32(0, sequence);
          view.setUint32(4, count);
          frame.fill(sequence & 0xff, 8);
          channel.send(frame);
          maxBufferedBytes = Math.max(maxBufferedBytes, channel.bufferedAmount);
          bytesSinceYield += count;
          if (bytesSinceYield >= 256 * 1024) {
            bytesSinceYield = 0;
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
        }
        const completed = await Promise.race([
          completion,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`VDO binary run ${run} timed out`)), 30_000),
          ),
        ]);
        const transferMs = performance.now() - started;
        return {
          payloadBytes,
          transferMs,
          bytesPerSecond: Math.round(payloadBytes / (transferMs / 1000)),
          maxBufferedBytes,
          receivedBytes: completed.receivedBytes,
          byteExact: completed.byteExact === true,
        };
      },
      { run, payloadBytes: payloadMiB * 1024 * 1024, chunkBytes },
    );
    results.push({ run, ...result });
    process.stdout.write(`vdo-binary run ${run}: ${JSON.stringify(result)}\n`);
  }

  const sortedRates = results.map((result) => result.bytesPerSecond).sort((a, b) => a - b);
  const report = {
      generatedAt: new Date().toISOString(),
      runtime: {
        browser: await browser.version(),
        node: process.version,
        sdk: "@vdoninja/sdk 1.5.5",
      },
      payloadMiB,
      repetitions,
      chunkBytes,
      connectionMs,
      route,
      medianBytesPerSecond: sortedRates[Math.floor(sortedRates.length / 2)],
      byteExact: results.every((result) => result.byteExact),
      results,
    };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`VDO_BINARY_RESULT ${JSON.stringify(report)}\n`);
  process.stdout.write(`Benchmark artifact: ${outputPath}\n`);
  await Promise.all([
    receiver.evaluate(() => window.benchmark.sdk.disconnect()),
    sender.evaluate(() => window.benchmark.sdk.disconnect()),
  ]);
} finally {
  await browser.close();
  await new Promise((resolve) => originServer.close(resolve));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${String(value)}`);
  }
  return parsed;
}
