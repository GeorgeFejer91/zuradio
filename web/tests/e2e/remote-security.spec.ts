import fs from "node:fs";
import { createHmac, pbkdf2Sync, randomUUID } from "node:crypto";

import { expect, test, type Page } from "@playwright/test";

interface RuntimeFile {
  hostUrl: string;
}

interface BroadcastSession {
  sessionId: string;
  epoch: number;
  passwordSalt: string;
  passwordIterations: number;
}

interface Snapshot {
  revision: number;
  player: { volume: number };
}

const runtimePath = process.env.ZURADIO_RUNTIME;
if (!runtimePath) throw new Error("ZURADIO_RUNTIME must name the running daemon's runtime.json");
const runtime = JSON.parse(fs.readFileSync(runtimePath, "utf8")) as RuntimeFile;
const passwordPath = process.env.ZURADIO_TEST_PASSWORD_FILE;
if (!passwordPath) throw new Error("ZURADIO_TEST_PASSWORD_FILE must name the daemon password file");
const password = fs.readFileSync(passwordPath, "utf8").replace(/[\r\n]+$/, "");

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
    const key = pbkdf2Sync(password, Buffer.from(session.passwordSalt, "base64url"), session.passwordIterations, 32, "sha256");
    const transcript = `zuradio/2|${session.sessionId}|${session.epoch}|control|${peerId}|${nonce}`;
    const proof = createHmac("sha256", key).update(transcript).digest("base64url");

    const forged = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      mode: "control",
      peerId,
      clientNonce: nonce,
      proof: "forged-proof",
    });
    expect(forged.status).toBe(401);

    const listenerEscalation = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      mode: "listen",
      peerId,
      clientNonce: nonce,
      proof,
    });
    expect(listenerEscalation.status).toBe(401);

    const listenerNonce = randomUUID();
    const listenerTranscript = `zuradio/2|${session.sessionId}|${session.epoch}|listen|${peerId}|${listenerNonce}`;
    const listenerProof = createHmac("sha256", key).update(listenerTranscript).digest("base64url");
    const listenerGrant = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      mode: "listen",
      peerId,
      clientNonce: listenerNonce,
      proof: listenerProof,
    });
    expect(listenerGrant.status).toBe(200);
    const listenerAction = await post(page, "/api/v1/remote/action", {
      grantId: (listenerGrant.body as { grantId: string }).grantId,
      peerId,
      sequence: 1,
      request: {
        protocol: 1,
        commandId: randomUUID(),
        expectedRevision: null,
        actor: { role: "controller", peerId },
        action: { kind: "pause" },
      },
    });
    expect(listenerAction.status).toBe(403);

    const uploadNonce = randomUUID();
    const uploadTranscript = `zuradio/2|${session.sessionId}|${session.epoch}|upload|${peerId}|${uploadNonce}`;
    const uploadProof = createHmac("sha256", key).update(uploadTranscript).digest("base64url");
    const uploadGrant = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      mode: "upload",
      peerId,
      clientNonce: uploadNonce,
      proof: uploadProof,
    });
    expect(uploadGrant.status).toBe(200);
    const uploadAction = await post(page, "/api/v1/remote/action", {
      grantId: (uploadGrant.body as { grantId: string }).grantId,
      peerId,
      sequence: 1,
      request: {
        protocol: 1,
        commandId: randomUUID(),
        expectedRevision: null,
        actor: { role: "controller", peerId },
        action: { kind: "pause" },
      },
    });
    expect(uploadAction.status).toBe(403);

    const verified = await post(page, "/api/v1/remote/verify", {
      sessionId: session.sessionId,
      mode: "control",
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
