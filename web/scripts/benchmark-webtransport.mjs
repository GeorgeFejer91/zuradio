import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { chromium } from "@playwright/test";

const port = Number(process.env.WEBTRANSPORT_PORT);
const digest = JSON.parse(process.env.WEBTRANSPORT_DIGEST ?? "null");
const payloadMiB = positiveInteger(process.env.ZURADIO_BENCHMARK_MIB, 64);
const repetitions = positiveInteger(process.env.ZURADIO_BENCHMARK_RUNS, 3);
const outputPath = path.resolve(
  process.cwd(),
  process.env.ZURADIO_BENCHMARK_OUTPUT ?? "../target/webtransport-benchmark.json",
);
if (!Number.isSafeInteger(port) || port <= 0 || !Array.isArray(digest) || digest.length !== 32) {
  throw new Error("WEBTRANSPORT_PORT and a 32-byte WEBTRANSPORT_DIGEST are required");
}

const originServer = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>Zuradio WebTransport benchmark</title>");
});
await new Promise((resolve) => originServer.listen(0, "127.0.0.1", resolve));
const originPort = originServer.address().port;
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${originPort}`);
  const results = [];
  for (let run = 1; run <= repetitions; run += 1) {
    const result = await page.evaluate(
      async ({ port, digest, payloadBytes }) => {
        const startedConnecting = performance.now();
        const transport = new WebTransport(`https://127.0.0.1:${port}/upload`, {
          serverCertificateHashes: [
            { algorithm: "sha-256", value: new Uint8Array(digest) },
          ],
        });
        await transport.ready;
        const connectionMs = performance.now() - startedConnecting;
        const stream = await transport.createBidirectionalStream();
        const writer = stream.writable.getWriter();
        const chunk = new Uint8Array(64 * 1024);
        chunk.fill(0xa5);
        const started = performance.now();
        let sent = 0;
        while (sent < payloadBytes) {
          const count = Math.min(chunk.byteLength, payloadBytes - sent);
          await writer.write(count === chunk.byteLength ? chunk : chunk.subarray(0, count));
          sent += count;
        }
        await writer.close();
        const response = await new Response(stream.readable).text();
        const transferMs = performance.now() - started;
        transport.close();
        return {
          payloadBytes,
          connectionMs,
          transferMs,
          bytesPerSecond: Math.round(payloadBytes / (transferMs / 1000)),
          byteExact: response === String(payloadBytes),
        };
      },
      { port, digest, payloadBytes: payloadMiB * 1024 * 1024 },
    );
    results.push({ run, ...result });
    process.stdout.write(`webtransport run ${run}: ${JSON.stringify(result)}\n`);
  }
  const sortedRates = results.map((result) => result.bytesPerSecond).sort((a, b) => a - b);
  const sortedConnections = results.map((result) => result.connectionMs).sort((a, b) => a - b);
  const report = {
    generatedAt: new Date().toISOString(),
    runtime: {
      browser: await browser.version(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      rustServer: "wtransport 0.7.2",
    },
    payloadMiB,
    repetitions,
    medianBytesPerSecond: sortedRates[Math.floor(sortedRates.length / 2)],
    medianConnectionMs: sortedConnections[Math.floor(sortedConnections.length / 2)],
    byteExact: results.every((result) => result.byteExact),
    runs: results,
  };
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`WEBTRANSPORT_RESULT ${JSON.stringify(report)}\n`);
  process.stdout.write(`Benchmark artifact: ${outputPath}\n`);
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
