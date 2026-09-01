import VDONinja, { type VDONinjaEvent } from "@vdoninja/sdk";
import type {
  Action,
  ActionRequest,
  AppSnapshot,
  BroadcastSession,
  CompanionInvitation,
  RemoteMode,
  RemoteUploadResponse,
  Track,
  UploadOperation,
  UploadOutcome,
} from "./types";

const HOST = "wss://wss.vdo.ninja";
const SALT = "vdo.ninja";
const MAX_MESSAGE_BYTES = 16_384;
const UPLOAD_CHUNK_BYTES = 8 * 1024;
const MAX_UPLOAD_FILES = 512;
const MAX_UPLOAD_FILE_BYTES = 512 * 1024 * 1024;

type MessageRecord = Record<string, unknown> & { type: string };

export interface HostBridgeCallbacks {
  snapshot(): AppSnapshot;
  verify(payload: unknown): Promise<unknown>;
  action(payload: unknown): Promise<unknown>;
  upload(payload: unknown): Promise<unknown>;
  onError(message: string): void;
}

interface HostGrant {
  grantId: string;
  peerId: string;
  mode: RemoteMode;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AudioRoute {
  room: string;
  stream: string;
  transportKey: string;
}

export interface UploadProgress {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  fileReceived: number;
  fileSize: number;
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
    const control = createSdk(session.controllerTransportKey, "Zuradio remote host");
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
      label: "Zuradio remote bridge",
    });
    this.publishState(this.callbacks.snapshot());
  }

  publishState(snapshot: AppSnapshot): void {
    this.listen?.sendData({ type: "zuradio.state", state: nowPlaying(snapshot) });
    for (const [uuid, grant] of this.grants) {
      if (grant.mode === "control") {
        this.control?.sendData({ type: "zuradio.snapshot", snapshot }, { uuid, allowFallback: false });
      }
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
        const mode = modeField(message, "mode");
        const response = (await this.callbacks.verify({
          sessionId: stringField(message, "sessionId", 64),
          mode,
          peerId,
          clientNonce: stringField(message, "clientNonce", 128),
          proof: stringField(message, "proof", 256),
        })) as { grantId: string; serverProof: string; expiresInSeconds: number; scopes: string[] };
        this.grants.set(uuid, { grantId: response.grantId, peerId, mode });
        this.control?.sendData(
          {
            type: "zuradio.ready",
            mode,
            serverProof: response.serverProof,
            expiresInSeconds: response.expiresInSeconds,
            scopes: response.scopes,
            audio:
              mode === "upload"
                ? null
                : {
                    room: this.session.listenRoom,
                    stream: this.session.listenStream,
                    transportKey: this.session.listenTransportKey,
                  },
            snapshot: mode === "control" ? this.callbacks.snapshot() : null,
            state: mode === "listen" ? nowPlaying(this.callbacks.snapshot()) : null,
          },
          { uuid, allowFallback: false },
        );
        return;
      }
      const grant = this.grants.get(uuid);
      if (!grant) throw new Error("This browser is not authenticated");
      const sequence = numberField(message, "sequence");
      if (message.type === "zuradio.action") {
        if (grant.mode !== "control") throw new Error("This grant cannot control the player");
        await this.callbacks.action({
          grantId: grant.grantId,
          peerId: grant.peerId,
          sequence,
          request: message.request,
        });
        const snapshot = this.callbacks.snapshot();
        this.control?.sendData(
          { type: "zuradio.applied", sequence, revision: snapshot.revision },
          { uuid, allowFallback: false },
        );
        this.publishState(snapshot);
      } else if (message.type === "zuradio.upload") {
        if (grant.mode !== "upload") throw new Error("This grant cannot upload music");
        const response = await this.callbacks.upload({
          grantId: grant.grantId,
          peerId: grant.peerId,
          sequence,
          operation: message.operation,
        });
        this.control?.sendData(
          { type: "zuradio.uploaded", sequence, response },
          { uuid, allowFallback: false },
        );
        const snapshot = (response as RemoteUploadResponse).snapshot;
        if (snapshot) this.publishState(snapshot);
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
  private helloSent = false;
  private helloSending = false;
  private passwordKey: Uint8Array<ArrayBuffer> | null = null;
  private pendingServerProof: string | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private readyWaiter: ReadyWaiter | null = null;

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly callbacks: CompanionCallbacks,
  ) {}

  get mode(): RemoteMode | null {
    return this.ready ? (this.invitation?.mode ?? null) : null;
  }

  get isController(): boolean {
    return this.mode === "control";
  }

  get isUploader(): boolean {
    return this.mode === "upload";
  }

  async connect(invitation: CompanionInvitation, password: string): Promise<void> {
    await this.disconnect();
    this.invitation = invitation;
    this.callbacks.onStatus("Authenticating with laptop…");
    this.passwordKey = await derivePasswordKey(password, invitation.passwordSalt, invitation.passwordIterations);
    const control = createSdk(invitation.controllerTransportKey, `Zuradio ${invitation.mode}`);
    this.control = control;
    this.attachErrors(control);
    control.addEventListener(
      "dataReceived",
      ((event: VDONinjaEvent<"dataReceived">) => {
        void this.handleControlMessage(event.detail.data);
      }) as EventListener,
    );
    control.addEventListener(
      "dataChannelOpen",
      (() => {
        void this.sendHello(invitation);
      }) as EventListener,
    );
    await control.connect();
    await control.joinRoom({ room: invitation.controllerRoom, password: invitation.controllerTransportKey });
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.readyWaiter?.timer === timer) this.readyWaiter = null;
        reject(new Error("The laptop did not complete authentication"));
      }, 20_000);
      this.readyWaiter = { resolve, reject, timer };
    });
    try {
      await control.view(invitation.controllerStream, {
        audio: false,
        video: false,
        dataOnly: true,
        downloads: false,
        allowresources: false,
        label: `Zuradio ${invitation.mode}`,
      });
      await this.ensureHello(invitation);
      await ready;
    } catch (error) {
      await this.disconnect();
      throw error;
    }
  }

  async send(action: Action): Promise<void> {
    if (!this.isController) throw new Error("Controller is not authenticated");
    const request: ActionRequest = {
      protocol: 1,
      commandId: crypto.randomUUID(),
      expectedRevision: this.revision,
      actor: { role: "controller", peerId: this.peerId },
      action,
    };
    await this.sendRequest("zuradio.action", { request });
  }

  async uploadFiles(files: File[], onProgress: (progress: UploadProgress) => void): Promise<UploadOutcome> {
    if (!this.isUploader) throw new Error("Upload mode is not authenticated");
    if (files.length === 0 || files.length > MAX_UPLOAD_FILES) {
      throw new Error(`Choose between 1 and ${MAX_UPLOAD_FILES} audio files`);
    }
    for (const file of files) {
      if (file.size === 0 || file.size > MAX_UPLOAD_FILE_BYTES) {
        throw new Error(`${file.name} is empty or larger than 512 MiB`);
      }
    }
    const transferId = `transfer-${crypto.randomUUID()}`;
    const entries = files.map((file) => ({
      file,
      fileId: `file-${crypto.randomUUID()}`,
      relativePath: file.webkitRelativePath || file.name,
    }));
    await this.sendUpload({
      kind: "begin",
      transferId,
      files: entries.map(({ file, fileId, relativePath }) => ({ fileId, relativePath, size: file.size })),
    });
    try {
      for (let fileIndex = 0; fileIndex < entries.length; fileIndex += 1) {
        const entry = entries[fileIndex];
        if (!entry) continue;
        const bytes = new Uint8Array(await entry.file.arrayBuffer());
        const digest = encodeHex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
        for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
          const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + UPLOAD_CHUNK_BYTES));
          await this.sendUpload({
            kind: "chunk",
            transferId,
            fileId: entry.fileId,
            offset,
            data: encodeBase64(chunk),
          });
          onProgress({
            fileName: entry.relativePath,
            fileIndex,
            fileCount: entries.length,
            fileReceived: offset + chunk.length,
            fileSize: bytes.length,
          });
        }
        await this.sendUpload({
          kind: "finish_file",
          transferId,
          fileId: entry.fileId,
          sha256: digest,
        });
      }
      const committed = await this.sendUpload({ kind: "commit", transferId });
      return committed.outcome;
    } catch (error) {
      await this.sendUpload({ kind: "abort", transferId }).catch(() => undefined);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    this.ready = false;
    this.helloSent = false;
    this.helloSending = false;
    this.sequence = 1;
    this.pendingServerProof = null;
    this.passwordKey?.fill(0);
    this.passwordKey = null;
    if (this.readyWaiter) {
      clearTimeout(this.readyWaiter.timer);
      this.readyWaiter.reject(new Error("Remote connection closed"));
      this.readyWaiter = null;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Remote connection closed"));
    }
    this.pendingRequests.clear();
    this.audio.pause();
    this.audio.srcObject = null;
    const listen = this.listen;
    const control = this.control;
    this.listen = null;
    this.control = null;
    this.invitation = null;
    await Promise.allSettled([listen?.disconnect(), control?.disconnect()]);
  }

  private async ensureHello(invitation: CompanionInvitation): Promise<void> {
    for (let attempt = 0; attempt < 40 && !this.helloSent && !this.ready; attempt += 1) {
      if (await this.sendHello(invitation)) return;
      await delay(250);
    }
    if (!this.helloSent && !this.ready) throw new Error("The laptop data channel is not ready");
  }

  private async sendHello(invitation: CompanionInvitation): Promise<boolean> {
    if (this.helloSent || this.ready) return true;
    if (!this.control || !this.passwordKey || this.helloSending) return false;
    this.helloSending = true;
    const clientNonce = randomBase64Url(24);
    const transcript = `zuradio/2|${invitation.session}|${invitation.epoch}|${invitation.mode}|${this.peerId}|${clientNonce}`;
    try {
      const proof = await hmac(this.passwordKey, transcript);
      const serverProof = await hmac(this.passwordKey, `${transcript}|accepted`);
      const sent = this.control.sendData({
        type: "zuradio.hello",
        sessionId: invitation.session,
        mode: invitation.mode,
        peerId: this.peerId,
        clientNonce,
        proof,
      });
      if (!sent) return false;
      this.pendingServerProof = serverProof;
      this.helloSent = true;
      this.passwordKey.fill(0);
      this.passwordKey = null;
      return true;
    } finally {
      this.helloSending = false;
    }
  }

  private async handleControlMessage(raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message) return;
    if (message.type === "zuradio.ready") {
      if (
        !this.invitation ||
        !this.pendingServerProof ||
        typeof message.serverProof !== "string" ||
        message.mode !== this.invitation.mode ||
        !constantTimeEqual(this.pendingServerProof, message.serverProof)
      ) {
        this.callbacks.onError("Laptop authentication failed");
        await this.disconnect();
        return;
      }
      this.pendingServerProof = null;
      if (this.invitation.mode === "control") {
        if (!isSnapshot(message.snapshot)) throw new Error("Controller state is unavailable");
        this.revision = message.snapshot.revision;
        this.callbacks.onSnapshot(message.snapshot);
      } else if (this.invitation.mode === "listen" && isPublicState(message.state)) {
        this.callbacks.onNowPlaying(message.state);
      }
      if (this.invitation.mode !== "upload") {
        if (!isAudioRoute(message.audio)) throw new Error("Live audio route is unavailable");
        await this.connectAudio(message.audio);
      }
      this.ready = true;
      this.callbacks.onStatus(
        this.invitation.mode === "control"
          ? "Controller connected"
          : this.invitation.mode === "upload"
            ? "Upload connected"
            : "Listening live",
      );
      if (this.readyWaiter) {
        clearTimeout(this.readyWaiter.timer);
        this.readyWaiter.resolve();
        this.readyWaiter = null;
      }
    } else if (message.type === "zuradio.snapshot" && isSnapshot(message.snapshot)) {
      this.revision = message.snapshot.revision;
      this.callbacks.onSnapshot(message.snapshot);
    } else if (message.type === "zuradio.applied") {
      this.resolveRequest(message.sequence, undefined, message.revision);
    } else if (message.type === "zuradio.uploaded" && isUploadResponse(message.response)) {
      if (message.response.snapshot) {
        this.revision = message.response.snapshot.revision;
        this.callbacks.onSnapshot(message.response.snapshot);
      }
      this.resolveRequest(message.sequence, message.response);
    } else if (message.type === "zuradio.rejected") {
      const reason = typeof message.message === "string" ? message.message : "Request rejected";
      const sequence = message.sequence;
      if (typeof sequence === "number" && Number.isSafeInteger(sequence)) {
        const pending = this.pendingRequests.get(sequence);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(sequence);
          pending.reject(new Error(reason));
          return;
        }
      }
      this.callbacks.onError(reason);
    }
  }

  private async connectAudio(route: AudioRoute): Promise<void> {
    const listen = createSdk(route.transportKey, "Zuradio listener");
    this.listen = listen;
    this.attachErrors(listen);
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
    await listen.connect();
    await listen.joinRoom({ room: route.room, password: route.transportKey });
    await listen.view(route.stream, {
      audio: true,
      video: false,
      downloads: false,
      allowresources: false,
      label: "Zuradio listener",
    });
  }

  private async sendUpload(operation: UploadOperation): Promise<RemoteUploadResponse> {
    if (!this.isUploader) throw new Error("Upload mode is not authenticated");
    return (await this.sendRequest("zuradio.upload", { operation }, 45_000)) as RemoteUploadResponse;
  }

  private sendRequest(type: string, payload: Record<string, unknown>, timeout = 10_000): Promise<unknown> {
    if (!this.control || !this.ready) return Promise.reject(new Error("Remote data channel is not ready"));
    const sequence = this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(sequence);
        reject(new Error("The laptop did not acknowledge the request"));
      }, timeout);
      this.pendingRequests.set(sequence, { resolve, reject, timer });
      const sent = this.control?.sendData({ type, peerId: this.peerId, sequence, ...payload });
      if (!sent) {
        clearTimeout(timer);
        this.pendingRequests.delete(sequence);
        reject(new Error("Remote data channel is not ready"));
        return;
      }
      this.sequence += 1;
    });
  }

  private resolveRequest(sequence: unknown, value: unknown, revision?: unknown): void {
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence)) return;
    const pending = this.pendingRequests.get(sequence);
    if (!pending) return;
    if (typeof revision === "number" && Number.isSafeInteger(revision)) this.revision = revision;
    clearTimeout(pending.timer);
    this.pendingRequests.delete(sequence);
    pending.resolve(value);
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
  } else {
    try {
      if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > MAX_MESSAGE_BYTES) return null;
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

function modeField(record: Record<string, unknown>, key: string): RemoteMode {
  const value = record[key];
  if (value !== "listen" && value !== "control" && value !== "upload") throw new Error(`Invalid ${key}`);
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

function isAudioRoute(value: unknown): value is AudioRoute {
  if (!value || typeof value !== "object") return false;
  const route = value as AudioRoute;
  return [route.room, route.stream, route.transportKey].every((field) => typeof field === "string" && field.length > 0);
}

function isUploadResponse(value: unknown): value is RemoteUploadResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as RemoteUploadResponse;
  return Boolean(response.outcome && typeof response.outcome.status === "string");
}

async function derivePasswordKey(password: string, salt: string, iterations: number): Promise<Uint8Array<ArrayBuffer>> {
  const encodedPassword = new TextEncoder().encode(password);
  if (encodedPassword.length < 8 || encodedPassword.length > 256) throw new Error("Password must contain 8 to 256 bytes");
  const material = await crypto.subtle.importKey("raw", encodedPassword, "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: decodeBase64Url(salt), iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

async function hmac(key: Uint8Array<ArrayBuffer>, message: string): Promise<string> {
  const imported = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.sign("HMAC", imported, new TextEncoder().encode(message))));
}

function randomBase64Url(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}
