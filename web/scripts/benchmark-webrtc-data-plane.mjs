import fs from "node:fs";
import path from "node:path";

import { chromium } from "@playwright/test";

const payloadMiB = positiveInteger(process.env.ZURADIO_BENCHMARK_MIB, 64);
const repetitions = positiveInteger(process.env.ZURADIO_BENCHMARK_RUNS, 3);
const outputPath = path.resolve(
  process.cwd(),
  process.env.ZURADIO_BENCHMARK_OUTPUT ?? "../target/webrtc-data-plane-benchmark.json",
);

const candidates = [
  { name: "binary-8k-ordered", chunkBytes: 8 * 1024, ordered: true, lanes: 1, yieldAfterBytes: 0 },
  { name: "binary-16k-ordered", chunkBytes: 16 * 1024, ordered: true, lanes: 1, yieldAfterBytes: 0 },
  { name: "binary-32k-ordered", chunkBytes: 32 * 1024, ordered: true, lanes: 1, yieldAfterBytes: 0 },
  { name: "binary-64k-ordered", chunkBytes: 64 * 1024, ordered: true, lanes: 1, yieldAfterBytes: 0 },
  { name: "binary-128k-ordered", chunkBytes: 128 * 1024, ordered: true, lanes: 1, yieldAfterBytes: 0 },
  {
    name: "binary-64k-ordered-responsive",
    chunkBytes: 64 * 1024,
    ordered: true,
    lanes: 1,
    yieldAfterBytes: 256 * 1024,
  },
  { name: "binary-64k-unordered-reliable", chunkBytes: 64 * 1024, ordered: false, lanes: 1, yieldAfterBytes: 0 },
  { name: "binary-64k-ordered-4-lanes", chunkBytes: 64 * 1024, ordered: true, lanes: 4, yieldAfterBytes: 0 },
];

const browser = await chromium.launch({
  headless: true,
  args: ["--autoplay-policy=no-user-gesture-required"],
});

try {
  const page = await browser.newPage();
  const results = [];
  for (const candidate of candidates) {
    for (let run = 1; run <= repetitions; run += 1) {
      const result = await page.evaluate(runCandidate, {
        ...candidate,
        payloadBytes: payloadMiB * 1024 * 1024,
      });
      results.push({ ...candidate, run, ...result });
      process.stdout.write(
        `${candidate.name} run ${run}: ${JSON.stringify(summarizeRun(result))}\n`,
      );
    }
  }

  const summaries = candidates.map((candidate) => {
    const matching = results.filter((result) => result.name === candidate.name);
    return {
      ...candidate,
      runs: matching.length,
      medianBytesPerSecond: percentile(
        matching.map((result) => result.bytesPerSecond),
        0.5,
      ),
      p95ControlRttMs: percentile(
        matching.flatMap((result) => result.controlRttMs),
        0.95,
      ),
      worstControlRttMs: Math.max(...matching.flatMap((result) => result.controlRttMs)),
      medianConnectionMs: percentile(
        matching.map((result) => result.connectionMs),
        0.5,
      ),
      route: matching[0]?.route ?? null,
      maxMessageSize: matching[0]?.maxMessageSize ?? null,
      byteExact: matching.every((result) => result.byteExact),
    };
  });
  summaries.sort((left, right) => right.medianBytesPerSecond - left.medianBytesPerSecond);

  const report = {
    generatedAt: new Date().toISOString(),
    runtime: {
      browser: await browser.version(),
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
    },
    payloadMiB,
    repetitions,
    highWaterBytes: 1024 * 1024,
    lowWaterBytes: 512 * 1024,
    summaries,
    runs: results,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`WebRTC data-plane benchmark: ${JSON.stringify(summaries)}\n`);
  process.stdout.write(`Benchmark artifact: ${outputPath}\n`);
} finally {
  await browser.close();
}

function positiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received ${String(value)}`);
  }
  return parsed;
}

function percentile(values, quantile) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

function summarizeRun(result) {
  return {
    payloadBytes: result.payloadBytes,
    transferMs: result.transferMs,
    bytesPerSecond: result.bytesPerSecond,
    connectionMs: result.connectionMs,
    controlRttP50Ms: percentile(result.controlRttMs, 0.5),
    controlRttP95Ms: percentile(result.controlRttMs, 0.95),
    controlRttWorstMs: Math.max(...result.controlRttMs),
    maxBufferedBytes: result.maxBufferedBytes,
    maxMessageSize: result.maxMessageSize,
    route: result.route,
    byteExact: result.byteExact,
  };
}

async function runCandidate(candidate) {
  function waitForIceGathering(connection) {
    if (connection.iceGatheringState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      const listener = () => {
        if (connection.iceGatheringState !== "complete") return;
        connection.removeEventListener("icegatheringstatechange", listener);
        resolve();
      };
      connection.addEventListener("icegatheringstatechange", listener);
    });
  }

  function waitForOpen(channel) {
    if (channel.readyState === "open") return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${channel.label} did not open`)), 10_000);
      channel.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  async function waitForReceiverChannels(channels, expected) {
    const deadline = performance.now() + 10_000;
    while (channels.size < expected) {
      if (performance.now() >= deadline) throw new Error("Receiver channels did not open");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function waitForDrain(channel, lowWaterBytes) {
    if (channel.bufferedAmount <= lowWaterBytes) return Promise.resolve();
    channel.bufferedAmountLowThreshold = lowWaterBytes;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${channel.label} did not drain`)), 10_000);
      channel.addEventListener(
        "bufferedamountlow",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }

  async function selectedRoute(connection) {
    const stats = await connection.getStats();
    const byId = new Map([...stats.values()].map((entry) => [entry.id, entry]));
    const pair = [...stats.values()].find(
      (entry) => entry.type === "candidate-pair" && entry.state === "succeeded" && entry.nominated,
    );
    if (!pair) return null;
    const local = byId.get(pair.localCandidateId);
    const remote = byId.get(pair.remoteCandidateId);
    return {
      localCandidateType: local?.candidateType ?? null,
      remoteCandidateType: remote?.candidateType ?? null,
      protocol: local?.protocol ?? null,
      currentRoundTripTimeMs:
        typeof pair.currentRoundTripTime === "number" ? pair.currentRoundTripTime * 1000 : null,
    };
  }

  const highWaterBytes = 1024 * 1024;
  const lowWaterBytes = 512 * 1024;
  const startedConnecting = performance.now();
  const sender = new RTCPeerConnection({ iceServers: [] });
  const receiver = new RTCPeerConnection({ iceServers: [] });
  const senderChannels = [];
  const receiverChannels = new Map();
  const controlRttMs = [];
  const pendingPings = new Map();
  let pingSequence = 0;
  let receivedBytes = 0;
  let receivedChunks = 0;
  let integrityFailure = null;
  let maxBufferedBytes = 0;
  const totalChunks = Math.ceil(candidate.payloadBytes / candidate.chunkBytes);
  const seen = new Uint8Array(totalChunks);

  const receiverComplete = new Promise((resolve) => {
    receiver.ondatachannel = (event) => {
      const channel = event.channel;
      channel.binaryType = "arraybuffer";
      receiverChannels.set(channel.label, channel);
      if (channel.label === "control") {
        channel.onmessage = (message) => channel.send(message.data);
        return;
      }
      channel.onmessage = (message) => {
        if (!(message.data instanceof ArrayBuffer)) {
          integrityFailure = `non-binary payload on ${channel.label}`;
          return;
        }
        const bytes = new Uint8Array(message.data);
        if (bytes.byteLength < 8) {
          integrityFailure = `short frame on ${channel.label}`;
          return;
        }
        const view = new DataView(message.data);
        const sequence = view.getUint32(0);
        const declaredBytes = view.getUint32(4);
        if (
          sequence >= totalChunks ||
          declaredBytes !== bytes.byteLength - 8 ||
          seen[sequence] !== 0
        ) {
          integrityFailure = `invalid or duplicate frame ${sequence}`;
          return;
        }
        const expected = sequence & 0xff;
        for (let index = 8; index < bytes.byteLength; index += 4096) {
          if (bytes[index] !== expected) {
            integrityFailure = `payload mismatch in frame ${sequence}`;
            return;
          }
        }
        if (bytes[bytes.byteLength - 1] !== expected) {
          integrityFailure = `payload tail mismatch in frame ${sequence}`;
          return;
        }
        seen[sequence] = 1;
        receivedChunks += 1;
        receivedBytes += declaredBytes;
        if (receivedChunks === totalChunks) resolve(performance.now());
      };
    };
  });

  const control = sender.createDataChannel("control", { ordered: true });
  control.onmessage = (event) => {
    const sequence = Number(event.data);
    const sentAt = pendingPings.get(sequence);
    if (sentAt !== undefined) {
      pendingPings.delete(sequence);
      controlRttMs.push(performance.now() - sentAt);
    }
  };
  for (let lane = 0; lane < candidate.lanes; lane += 1) {
    const channel = sender.createDataChannel(`bulk-${lane}`, { ordered: candidate.ordered });
    channel.binaryType = "arraybuffer";
    senderChannels.push(channel);
  }

  try {
    await sender.setLocalDescription(await sender.createOffer());
    await waitForIceGathering(sender);
    await receiver.setRemoteDescription(sender.localDescription);
    await receiver.setLocalDescription(await receiver.createAnswer());
    await waitForIceGathering(receiver);
    await sender.setRemoteDescription(receiver.localDescription);
    await Promise.all([waitForOpen(control), ...senderChannels.map(waitForOpen)]);
    await waitForReceiverChannels(receiverChannels, candidate.lanes + 1);
    const connectionMs = performance.now() - startedConnecting;
    const route = await selectedRoute(sender);
    const maxMessageSize = sender.sctp?.maxMessageSize ?? null;
    if (maxMessageSize && candidate.chunkBytes + 8 > maxMessageSize) {
      throw new Error(
        `${candidate.name} frame exceeds negotiated maxMessageSize ${maxMessageSize}`,
      );
    }

    const pingTimer = setInterval(() => {
      if (control.readyState !== "open") return;
      pingSequence += 1;
      pendingPings.set(pingSequence, performance.now());
      control.send(String(pingSequence));
    }, 25);

    const transferStarted = performance.now();
    let bytesSinceYield = 0;
    try {
      for (let sequence = 0; sequence < totalChunks; sequence += 1) {
        const channel = senderChannels[sequence % senderChannels.length];
        if (channel.bufferedAmount > highWaterBytes) {
          await waitForDrain(channel, lowWaterBytes);
        }
        const offset = sequence * candidate.chunkBytes;
        const payloadBytes = Math.min(candidate.chunkBytes, candidate.payloadBytes - offset);
        const frame = new Uint8Array(payloadBytes + 8);
        const view = new DataView(frame.buffer);
        view.setUint32(0, sequence);
        view.setUint32(4, payloadBytes);
        frame.fill(sequence & 0xff, 8);
        channel.send(frame);
        maxBufferedBytes = Math.max(maxBufferedBytes, channel.bufferedAmount);
        bytesSinceYield += payloadBytes;
        if (candidate.yieldAfterBytes > 0 && bytesSinceYield >= candidate.yieldAfterBytes) {
          bytesSinceYield = 0;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      const transferFinished = await receiverComplete;
      const transferMs = transferFinished - transferStarted;
      await new Promise((resolve) => setTimeout(resolve, 30));
      const byteExact =
        integrityFailure === null &&
        receivedBytes === candidate.payloadBytes &&
        receivedChunks === totalChunks &&
        seen.every((value) => value === 1);
      if (!byteExact) {
        throw new Error(
          integrityFailure ??
            `received ${receivedBytes}/${candidate.payloadBytes} bytes in ${receivedChunks}/${totalChunks} chunks`,
        );
      }
      return {
        payloadBytes: candidate.payloadBytes,
        transferMs,
        bytesPerSecond: Math.round(candidate.payloadBytes / (transferMs / 1000)),
        connectionMs,
        controlRttMs,
        maxBufferedBytes,
        maxMessageSize,
        route,
        byteExact,
      };
    } finally {
      clearInterval(pingTimer);
    }
  } finally {
    for (const channel of senderChannels) channel.close();
    control.close();
    sender.close();
    receiver.close();
  }
}
