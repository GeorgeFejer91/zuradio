import fs from "node:fs";
import { createHmac, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

interface RuntimeFile {
  hostUrl: string;
}

interface BroadcastSession {
  sessionId: string;
  epoch: number;
  controllerPairingKey: string;
}

interface Snapshot {
  revision: number;
  player: { volume: number };
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeFile;

test("binds controller grants to proof, broadcast, peer, and monotonic sequence", async ({ page }) => {
  await page.goto(runtime.hostUrl);
  await expect(page.getByRole("heading", { name: "Zuradio", exact: true })).toBeVisible();
  await post(page, "/api/v1/broadcast/stop", undefined);
  const started = await post(page, "/api/v1/broadcast/start", undefined);
  expect(started.status).toBe(200);
  const session = started.body as BroadcastSession;

  try {
    const peerId = `security-test-${randomUUID()}`;
    const nonce = randomUUID();
    const transcript = `zuradio/1|${session.sessionId}|${session.epoch}|controller|${peerId}|${nonce}`;
    const proof = createHmac("sha256", session.controllerPairingKey).update(transcript).digest("base64url");

    const forged = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      role: "controller",
      peerId,
      clientNonce: nonce,
      proof: "forged-proof",
    });
    expect(forged.status).toBe(401);

    const listenerEscalation = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      role: "listener",
      peerId,
      clientNonce: nonce,
      proof,
    });
    expect(listenerEscalation.status).toBe(403);

    const verified = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      role: "controller",
      peerId,
      clientNonce: nonce,
      proof,
    });
    expect(verified.status).toBe(200);
    const grantId = (verified.body as { grantId: string }).grantId;
    expect(grantId.length).toBeGreaterThan(32);

    const initial = await get<Snapshot>(page, "/api/v1/snapshot");
    const command = {
      grantId,
      peerId,
      sequence: 1,
      request: {
        protocol: 1,
        commandId: randomUUID(),
        expectedRevision: initial.revision,
        actor: { role: "local", peerId: "spoofed" },
        action: { kind: "set_volume", volume: 37 },
      },
    };
    const applied = await post(page, "/api/v1/remote/action", command);
    expect(applied.status).toBe(200);
    expect((await get<Snapshot>(page, "/api/v1/snapshot")).player.volume).toBe(37);

    const replay = await post(page, "/api/v1/remote/action", command);
    expect(replay.status).toBe(403);

    const wrongPeer = await post(page, "/api/v1/remote/action", {
      ...command,
      peerId: `${peerId}-other`,
      sequence: 2,
      request: { ...command.request, commandId: randomUUID(), expectedRevision: initial.revision + 1 },
    });
    expect(wrongPeer.status).toBe(403);

    const current = await get<Snapshot>(page, "/api/v1/snapshot");
    const restored = await post(page, "/api/v1/remote/action", {
      ...command,
      sequence: 2,
      request: {
        ...command.request,
        commandId: randomUUID(),
        expectedRevision: current.revision,
        action: { kind: "set_volume", volume: initial.player.volume },
      },
    });
    expect(restored.status).toBe(200);

    await post(page, "/api/v1/broadcast/stop", undefined);
    const revoked = await post(page, "/api/v1/remote/action", {
      ...command,
      sequence: 3,
      request: { ...command.request, commandId: randomUUID(), expectedRevision: current.revision + 1 },
    });
    expect(revoked.status).toBe(401);
  } finally {
    await post(page, "/api/v1/broadcast/stop", undefined);
  }
});

async function post(page: Page, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ path: requestPath, body: requestBody }) => {
      const response = await fetch(requestPath, {
        method: "POST",
        headers: requestBody === undefined ? undefined : { "content-type": "application/json" },
        body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    { path, body },
  );
}

async function get<T>(page: Page, path: string): Promise<T> {
  return page.evaluate(async (requestPath) => {
    const response = await fetch(requestPath);
    if (!response.ok) throw new Error(`GET ${requestPath} failed with ${response.status}`);
    return response.json() as Promise<T>;
  }, path);
}
