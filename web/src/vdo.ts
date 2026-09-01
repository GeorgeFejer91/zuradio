import VDONinja, { type VDONinjaEvent } from "@vdoninja/sdk";
import type {
  Action,
  ActionRequest,
  AppSnapshot,
  BroadcastSession,
  CompanionInvitation,
  Track,
} from "./types";

const HOST = "wss://wss.vdo.ninja";
const SALT = "vdo.ninja";
const MAX_MESSAGE_BYTES = 16_384;

type MessageRecord = Record<string, unknown> & { type: string };

export interface HostBridgeCallbacks {
  snapshot(): AppSnapshot;
  verify(payload: unknown): Promise<unknown>;
  action(payload: unknown): Promise<unknown>;
  onError(message: string): void;
}

interface HostGrant {
  grantId: string;
  peerId: string;
}

interface PendingCommand {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class HostBroadcastBridge {
  private listen: VDONinja | null = null;
  private control: VDONinja | null = null;
  private session: BroadcastSession | null = null;
  private grants = new Map<string, HostGrant>();

  constructor(private readonly callbacks: HostBridgeCallbacks) {}

  async start(session: BroadcastSession, stream: MediaStream): Promise<void> {
    await this.stop();
    this.session = session;
    const listen = createSdk(session.listenTransportKey, "Zuradio listen host");
    const control = createSdk(session.controllerTransportKey, "Zuradio controller host");
    this.listen = listen;
    this.control = control;
    this.attachErrors(listen);
    this.attachErrors(control);
    listen.addEventListener(
      "dataChannelOpen",
      ((event: VDONinjaEvent<"dataChannelOpen">) => {
        listen.sendData(
          { type: "zuradio.state", state: nowPlaying(this.callbacks.snapshot()) },
          { uuid: event.detail.uuid, allowFallback: false },
        );
      }) as EventListener,
    );
    control.addEventListener(
      "dataReceived",
      ((event: VDONinjaEvent<"dataReceived">) => {
        void this.handleControl(event.detail.uuid, event.detail.data);
      }) as EventListener,
    );
    control.addEventListener(
      "peerDisconnected",
      ((event: VDONinjaEvent<"peerDisconnected">) => {
        this.grants.delete(event.detail.uuid);
      }) as EventListener,
    );
    await Promise.all([listen.connect(), control.connect()]);
    await Promise.all([
      listen.joinRoom({ room: session.listenRoom, password: session.listenTransportKey }),
      control.joinRoom({ room: session.controllerRoom, password: session.controllerTransportKey }),
    ]);
    await listen.publish(stream, {
      room: session.listenRoom,
      streamID: session.listenStream,
      password: session.listenTransportKey,
      label: "Zuradio live audio",
      media: { audio: { codec: "opus" } },
    });
    await control.announce({
      room: session.controllerRoom,
      streamID: session.controllerStream,
      password: session.controllerTransportKey,
      label: "Zuradio control",
    });
    this.publishState(this.callbacks.snapshot());
  }

  publishState(snapshot: AppSnapshot): void {
    const publicState = nowPlaying(snapshot);
    this.listen?.sendData({ type: "zuradio.state", state: publicState });
    for (const [uuid] of this.grants) {
      this.control?.sendData({ type: "zuradio.snapshot", snapshot }, { uuid, allowFallback: false });
    }
  }

  async stop(): Promise<void> {
    this.session = null;
    this.grants.clear();
    const listen = this.listen;
    const control = this.control;
    this.listen = null;
    this.control = null;
    listen?.stopPublishing();
    control?.stopPublishing();
    await Promise.allSettled([listen?.disconnect(), control?.disconnect()]);
  }

  private async handleControl(uuid: string, raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message || !this.session) return;
    try {
      if (message.type === "zuradio.hello") {
        const peerId = stringField(message, "peerId", 128);
        const response = (await this.callbacks.verify({
          sessionId: stringField(message, "sessionId", 64),
          role: "controller",
          peerId,
          clientNonce: stringField(message, "clientNonce", 128),
          proof: stringField(message, "proof", 256),
        })) as { grantId: string; serverProof: string; expiresInSeconds: number; scopes: string[] };
        this.grants.set(uuid, { grantId: response.grantId, peerId });
        this.control?.sendData(
          {
            type: "zuradio.ready",
            serverProof: response.serverProof,
            expiresInSeconds: response.expiresInSeconds,
            scopes: response.scopes,
            snapshot: this.callbacks.snapshot(),
          },
          { uuid, allowFallback: false },
        );
        return;
      }
      if (message.type === "zuradio.action") {
        const grant = this.grants.get(uuid);
        if (!grant) throw new Error("This controller is not authenticated");
        await this.callbacks.action({
          grantId: grant.grantId,
          peerId: grant.peerId,
          sequence: numberField(message, "sequence"),
          request: message.request,
        });
        const snapshot = this.callbacks.snapshot();
        this.control?.sendData(
          { type: "zuradio.applied", sequence: message.sequence, revision: snapshot.revision },
          { uuid, allowFallback: false },
        );
        this.publishState(snapshot);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Remote request failed";
      this.control?.sendData(
        { type: "zuradio.rejected", message: reason, sequence: message.sequence ?? null },
        { uuid, allowFallback: false },
      );
    }
  }

  private attachErrors(sdk: VDONinja): void {
    sdk.addEventListener("error", ((event: CustomEvent<{ error?: Error }>) => {
      this.callbacks.onError(event.detail.error?.message ?? "VDO.Ninja connection failed");
    }) as EventListener);
  }
}

export interface CompanionCallbacks {
  onSnapshot(snapshot: AppSnapshot): void;
  onNowPlaying(state: PublicNowPlaying): void;
  onStatus(status: string): void;
  onError(message: string): void;
}

export class CompanionBridge {
  private listen: VDONinja | null = null;
  private control: VDONinja | null = null;
  private invitation: CompanionInvitation | null = null;
  private peerId = crypto.randomUUID();
  private sequence = 1;
  private revision = 0;
  private ready = false;
  private pendingServerProof: string | null = null;
  private pendingCommands = new Map<number, PendingCommand>();

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly callbacks: CompanionCallbacks,
  ) {}

  get isController(): boolean {
    return this.invitation?.role === "controller" && this.ready;
  }

  async connect(invitation: CompanionInvitation): Promise<void> {
    await this.disconnect();
    this.invitation = invitation;
    this.callbacks.onStatus("Connecting to laptop…");
    const listen = createSdk(invitation.listenTransportKey, "Zuradio listener");
    this.listen = listen;
    listen.addEventListener(
      "track",
      ((event: VDONinjaEvent<"track">) => {
        if (event.detail.track.kind !== "audio") return;
        this.audio.srcObject = new MediaStream([event.detail.track]);
        void this.audio.play().catch(() => this.callbacks.onStatus("Tap play to hear the live stream"));
      }) as EventListener,
    );
    listen.addEventListener(
      "dataReceived",
      ((event: VDONinjaEvent<"dataReceived">) => {
        const message = parseMessage(event.detail.data);
        if (message?.type === "zuradio.state" && isPublicState(message.state)) {
          this.callbacks.onNowPlaying(message.state);
        }
      }) as EventListener,
    );
    this.attachErrors(listen);
    await listen.connect();
    await listen.joinRoom({ room: invitation.listenRoom, password: invitation.listenTransportKey });
    await listen.view(invitation.listenStream, {
      audio: true,
      video: false,
      downloads: false,
      allowresources: false,
      label: "Zuradio listener",
    });

    if (invitation.role === "controller") await this.connectController(invitation);
    this.callbacks.onStatus(invitation.role === "controller" ? "Controller connected" : "Listening live");
  }

  async send(action: Action): Promise<void> {
    if (!this.control || !this.isController) throw new Error("Controller is not authenticated");
    const sequence = this.sequence;
    const request: ActionRequest = {
      protocol: 1,
      commandId: crypto.randomUUID(),
      expectedRevision: this.revision,
      actor: { role: "controller", peerId: this.peerId },
      action,
    };
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(sequence);
        reject(new Error("The laptop did not acknowledge the command"));
      }, 10_000);
      this.pendingCommands.set(sequence, { resolve, reject, timer });
      const sent = this.control?.sendData({
        type: "zuradio.action",
        peerId: this.peerId,
        sequence,
        request,
      });
      if (!sent) {
        clearTimeout(timer);
        this.pendingCommands.delete(sequence);
        reject(new Error("Controller data channel is not ready"));
        return;
      }
      this.sequence += 1;
    });
  }

  async disconnect(): Promise<void> {
    this.ready = false;
    this.sequence = 1;
    this.pendingServerProof = null;
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Controller disconnected"));
    }
    this.pendingCommands.clear();
    this.audio.pause();
    this.audio.srcObject = null;
    const listen = this.listen;
    const control = this.control;
    this.listen = null;
    this.control = null;
    await Promise.allSettled([listen?.disconnect(), control?.disconnect()]);
  }

  private async connectController(invitation: CompanionInvitation): Promise<void> {
    if (
      !invitation.controllerRoom ||
      !invitation.controllerStream ||
      !invitation.controllerTransportKey ||
      !invitation.pairingKey
    ) {
      throw new Error("Controller invitation is incomplete");
    }
    const control = createSdk(invitation.controllerTransportKey, "Zuradio controller");
    this.control = control;
    this.attachErrors(control);
    control.addEventListener(
      "dataReceived",
      ((event: VDONinjaEvent<"dataReceived">) => {
        void this.handleControllerMessage(event.detail.data);
      }) as EventListener,
    );
    control.addEventListener(
      "dataChannelOpen",
      (() => {
        void this.sendHello(invitation);
      }) as EventListener,
    );
    await control.connect();
    await control.joinRoom({
      room: invitation.controllerRoom,
      password: invitation.controllerTransportKey,
    });
    await control.view(invitation.controllerStream, {
      audio: false,
      video: false,
      dataOnly: true,
      downloads: false,
      allowresources: false,
      label: "Zuradio controller",
    });
  }

  private async sendHello(invitation: CompanionInvitation): Promise<void> {
    if (!this.control || !invitation.pairingKey || this.pendingServerProof || this.ready) return;
    const clientNonce = randomBase64Url(24);
    const transcript = `zuradio/1|${invitation.session}|${invitation.epoch}|controller|${this.peerId}|${clientNonce}`;
    const proof = await hmac(invitation.pairingKey, transcript);
    this.pendingServerProof = await hmac(invitation.pairingKey, `${transcript}|accepted`);
    this.control.sendData({
      type: "zuradio.hello",
      sessionId: invitation.session,
      role: "controller",
      peerId: this.peerId,
      clientNonce,
      proof,
    });
  }

  private async handleControllerMessage(raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message) return;
    if (message.type === "zuradio.ready" && isSnapshot(message.snapshot)) {
      if (
        !this.pendingServerProof ||
        typeof message.serverProof !== "string" ||
        !constantTimeEqual(this.pendingServerProof, message.serverProof)
      ) {
        this.callbacks.onError("Controller host authentication failed");
        await this.disconnect();
        return;
      }
      this.pendingServerProof = null;
      this.ready = true;
      this.revision = message.snapshot.revision;
      this.callbacks.onSnapshot(message.snapshot);
      this.callbacks.onStatus("Controller connected");
    } else if (message.type === "zuradio.snapshot" && isSnapshot(message.snapshot)) {
      this.revision = message.snapshot.revision;
      this.callbacks.onSnapshot(message.snapshot);
    } else if (message.type === "zuradio.applied") {
      const sequence = message.sequence;
      const revision = message.revision;
      if (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) return;
      const pending = this.pendingCommands.get(sequence);
      if (!pending) return;
      if (typeof revision === "number" && Number.isSafeInteger(revision)) this.revision = revision;
      clearTimeout(pending.timer);
      this.pendingCommands.delete(sequence);
      pending.resolve();
    } else if (message.type === "zuradio.rejected") {
      const reason = typeof message.message === "string" ? message.message : "Action rejected";
      const sequence = message.sequence;
      if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
        const pending = this.pendingCommands.get(sequence);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingCommands.delete(sequence);
          pending.reject(new Error(reason));
          return;
        }
      }
      this.callbacks.onError(reason);
    }
  }

  private attachErrors(sdk: VDONinja): void {
    sdk.addEventListener("error", ((event: CustomEvent<{ error?: Error }>) => {
      this.callbacks.onError(event.detail.error?.message ?? "VDO.Ninja connection failed");
    }) as EventListener);
  }
}

export interface PublicNowPlaying {
  revision: number;
  status: string;
  track: Pick<Track, "id" | "title" | "artist" | "album" | "durationMs"> | null;
  positionMs: number;
}

function createSdk(password: string, label: string): VDONinja {
  return new VDONinja({
    host: HOST,
    password,
    salt: SALT,
    label,
    debug: false,
    turnServers: null,
    autoRecover: true,
    autoRelay: true,
  });
}

function parseMessage(raw: unknown): MessageRecord | null {
  let value = raw;
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) return null;
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== "string" || record.type.length > 64) return null;
  return record as MessageRecord;
}

function stringField(record: Record<string, unknown>, key: string, max: number): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${key}`);
  }
  return value;
}

function nowPlaying(snapshot: AppSnapshot): PublicNowPlaying {
  const track = snapshot.tracks.find((candidate) => candidate.id === snapshot.player.currentTrackId);
  return {
    revision: snapshot.revision,
    status: snapshot.player.status,
    track: track
      ? {
          id: track.id,
          title: track.title,
          artist: track.artist,
          album: track.album,
          durationMs: track.durationMs,
        }
      : null,
    positionMs: snapshot.player.positionMs,
  };
}

function isSnapshot(value: unknown): value is AppSnapshot {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as AppSnapshot).revision === "number" &&
      Array.isArray((value as AppSnapshot).tracks),
  );
}

function isPublicState(value: unknown): value is PublicNowPlaying {
  return Boolean(value && typeof value === "object" && typeof (value as PublicNowPlaying).revision === "number");
}

async function hmac(key: string, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message))));
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}
