import VDONinja, { type VDONinjaEvent } from "@vdoninja/sdk";
import { deriveRendezvousRoute, type RendezvousRoute } from "./rendezvous";
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
const MAX_RENDEZVOUS_PEERS = 16;
const MAX_STALE_SESSION_RETRIES = 3;
const MAX_TRANSIENT_CONNECT_RETRIES = 4;
const TRUST_STORAGE_KEY = "zuradio.trusted-browser.v1";
const TRUST_LIFETIME_MS = 24 * 60 * 60 * 1_000;

type MessageRecord = Record<string, unknown> & { type: string };

export interface HostBridgeCallbacks {
  snapshot(): AppSnapshot;
  broadcast(): Promise<BroadcastSession | null>;
  verify(payload: unknown): Promise<unknown>;
  action(payload: unknown): Promise<unknown>;
  upload(payload: unknown): Promise<unknown>;
  onSessionReplaced(): void;
  onError(message: string): void;
}

interface HostGrant {
  grantId: string;
  transportUuid: string;
  peerId: string;
  mode: RemoteMode;
  expiresAt: number;
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

interface BeaconWaiter {
  resolve(invitation: CompanionInvitation): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

interface AudioRoute {
  room: string;
  stream: string;
  transportKey: string;
}

interface PendingHello {
  message: MessageRecord;
  serverProof: string;
}

interface StoredTrustedDevice {
  version: 1;
  deviceId: string;
  token: string;
  expiresAt: number;
  route: RendezvousRoute;
}

type ConnectionAuth =
  | { kind: "password"; password: string; deviceId: string }
  | { kind: "device"; trusted: StoredTrustedDevice };

export interface UploadProgress {
  fileName: string;
  fileIndex: number;
  fileCount: number;
  fileReceived: number;
  fileSize: number;
  cataloguedCount: number;
}

export class HostBroadcastBridge {
  private listen: VDONinja | null = null;
  private rendezvous: VDONinja | null = null;
  private control: VDONinja | null = null;
  private session: BroadcastSession | null = null;
  private grants = new Map<string, HostGrant>();
  private latestGrantByTransport = new Map<string, string>();

  constructor(private readonly callbacks: HostBridgeCallbacks) {}

  async start(session: BroadcastSession, stream: MediaStream): Promise<void> {
    await this.stop();
    this.session = session;
    const listen = createSdk(session.listenTransportKey, "Zuradio listen host");
    const rendezvous = createSdk(session.rendezvousTransportKey, "Zuradio rendezvous host");
    const control = createSdk(session.controllerTransportKey, "Zuradio remote host");
    this.listen = listen;
    this.rendezvous = rendezvous;
    this.control = control;
    try {
      this.attachErrors(listen);
      this.attachErrors(rendezvous);
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
      rendezvous.addEventListener(
        "dataReceived",
        ((event: VDONinjaEvent<"dataReceived">) => {
          void this.handleDiscovery(event.detail.uuid, event.detail.data);
        }) as EventListener,
      );
      control.addEventListener(
        "dataReceived",
        ((event: VDONinjaEvent<"dataReceived">) => {
          void this.handleControl(event.detail.uuid, event.detail.data);
        }) as EventListener,
      );
      await Promise.all([listen.connect(), rendezvous.connect(), control.connect()]);
      await Promise.all([
        listen.joinRoom({ room: session.listenRoom, password: session.listenTransportKey }),
        rendezvous.joinRoom({ room: session.rendezvousRoom, password: session.rendezvousTransportKey }),
        control.joinRoom({ room: session.controllerRoom, password: session.controllerTransportKey }),
      ]);
      await Promise.all([
        control.announce({
          room: session.controllerRoom,
          streamID: session.controllerStream,
          password: session.controllerTransportKey,
          label: "Zuradio remote bridge",
        }),
        rendezvous.announce({
          room: session.rendezvousRoom,
          streamID: session.rendezvousStream,
          password: session.rendezvousTransportKey,
          label: "Zuradio password rendezvous",
        }),
      ]);
      void listen
        .publish(stream, {
          room: session.listenRoom,
          streamID: session.listenStream,
          password: session.listenTransportKey,
          label: "Zuradio live audio",
          media: { audio: { codec: "opus" } },
        })
        .catch((error: unknown) => {
          this.callbacks.onError(error instanceof Error ? error.message : "Live audio publication failed");
        });
      this.publishState(this.callbacks.snapshot());
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  publishState(snapshot: AppSnapshot): void {
    this.listen?.sendData({ type: "zuradio.state", state: nowPlaying(snapshot) });
    this.pruneGrants();
    for (const grant of this.grants.values()) {
      if (grant.mode === "control") {
        this.control?.sendData(
          { type: "zuradio.snapshot", snapshot },
          { uuid: grant.transportUuid, allowFallback: false },
        );
      }
    }
  }

  async stop(): Promise<void> {
    this.session = null;
    this.grants.clear();
    this.latestGrantByTransport.clear();
    const listen = this.listen;
    const rendezvous = this.rendezvous;
    const control = this.control;
    this.listen = null;
    this.rendezvous = null;
    this.control = null;
    listen?.stopPublishing();
    rendezvous?.stopPublishing();
    control?.stopPublishing();
    await Promise.allSettled([listen?.disconnect(), rendezvous?.disconnect(), control?.disconnect()]);
  }

  private async handleDiscovery(uuid: string, raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message || !this.session || message.type !== "zuradio.discover") return;
    const session = this.session;
    try {
      const nonce = stringField(message, "nonce", 128);
      const mode = modeField(message, "mode");
      const current = await this.callbacks.broadcast();
      if (
        !current ||
        current.sessionId !== session.sessionId ||
        current.epoch !== session.epoch
      ) {
        if (this.session === session) {
          await this.stop();
          this.callbacks.onSessionReplaced();
        }
        return;
      }
      if (this.session !== session) return;
      this.rendezvous?.sendData(
        {
          type: "zuradio.beacon",
          nonce,
          mode,
          session: session.sessionId,
          epoch: session.epoch,
          controllerRoom: session.controllerRoom,
          controllerStream: session.controllerStream,
          controllerTransportKey: session.controllerTransportKey,
          passwordSalt: session.passwordSalt,
          passwordIterations: session.passwordIterations,
        },
        { uuid, allowFallback: false },
      );
    } catch {
      // Malformed discovery traffic is intentionally ignored on the public rendezvous plane.
    }
  }

  private async handleControl(uuid: string, raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message || !this.session) return;
    try {
      if (message.type === "zuradio.hello") {
        const peerId = stringField(message, "peerId", 128);
        const mode = modeField(message, "mode");
        const authKind = message.authKind;
        if (authKind !== undefined && authKind !== "password" && authKind !== "device") {
          throw new Error("Invalid authentication kind");
        }
        const response = (await this.callbacks.verify({
          sessionId: stringField(message, "sessionId", 64),
          mode,
          peerId,
          clientNonce: stringField(message, "clientNonce", 128),
          proof: stringField(message, "proof", 256),
          ...(authKind ? { authKind } : {}),
          ...(typeof message.deviceId === "string" ? { deviceId: stringField(message, "deviceId", 128) } : {}),
          ...(typeof message.deviceToken === "string"
            ? { deviceToken: stringField(message, "deviceToken", 2_048) }
            : {}),
        })) as {
          grantId: string;
          serverProof: string;
          expiresInSeconds: number;
          scopes: string[];
          trustedDevice?: { token: string; expiresAt: number } | null;
        };
        const previousGrantId = this.latestGrantByTransport.get(uuid);
        if (previousGrantId) this.grants.delete(previousGrantId);
        this.latestGrantByTransport.set(uuid, response.grantId);
        this.grants.set(response.grantId, {
          grantId: response.grantId,
          transportUuid: uuid,
          peerId,
          mode,
          expiresAt: Date.now() + response.expiresInSeconds * 1_000,
        });
        this.control?.sendData(
          {
            type: "zuradio.ready",
            grantId: response.grantId,
            mode,
            serverProof: response.serverProof,
            expiresInSeconds: response.expiresInSeconds,
            scopes: response.scopes,
            trustedDevice: response.trustedDevice ?? null,
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
      const suppliedGrantId =
        typeof message.grantId === "string" ? stringField(message, "grantId", 256) : null;
      const grantId = suppliedGrantId ?? this.latestGrantByTransport.get(uuid);
      const grant = grantId ? this.grants.get(grantId) : null;
      if (
        !grant ||
        grant.transportUuid !== uuid ||
        stringField(message, "peerId", 128) !== grant.peerId ||
        grant.expiresAt <= Date.now()
      ) {
        throw new Error("This browser is not authenticated");
      }
      if (message.type === "zuradio.goodbye") {
        this.grants.delete(grant.grantId);
        if (this.latestGrantByTransport.get(uuid) === grant.grantId) {
          this.latestGrantByTransport.delete(uuid);
        }
        return;
      }
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

  private pruneGrants(): void {
    const now = Date.now();
    for (const [grantId, grant] of this.grants) {
      if (grant.expiresAt > now) continue;
      this.grants.delete(grantId);
      if (this.latestGrantByTransport.get(grant.transportUuid) === grantId) {
        this.latestGrantByTransport.delete(grant.transportUuid);
      }
    }
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
  private rendezvous: VDONinja | null = null;
  private control: VDONinja | null = null;
  private invitation: CompanionInvitation | null = null;
  private peerId = crypto.randomUUID();
  private sequence = 1;
  private revision = 0;
  private ready = false;
  private helloSent = false;
  private helloSending = false;
  private authKey: Uint8Array<ArrayBuffer> | null = null;
  private connectionAuth: ConnectionAuth | null = null;
  private connectionRoute: RendezvousRoute | null = null;
  private pendingServerProof: string | null = null;
  private pendingHello: PendingHello | null = null;
  private pendingRequests = new Map<number, PendingRequest>();
  private readyWaiter: ReadyWaiter | null = null;
  private beaconWaiter: BeaconWaiter | null = null;
  private discoveryNonce: string | null = null;
  private requestedMode: RemoteMode | null = null;
  private discoveryPeerUuids = new Set<string>();
  private controlPeerUuid: string | null = null;
  private grantId: string | null = null;
  private analysisContext: AudioContext | null = null;
  private analysisSource: MediaStreamAudioSourceNode | null = null;
  private analysisAnalyser: AnalyserNode | null = null;
  private analysisData: Uint8Array<ArrayBuffer> | null = null;

  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly callbacks: CompanionCallbacks,
  ) {
    this.audio.addEventListener("play", () => void this.analysisContext?.resume());
  }

  get mode(): RemoteMode | null {
    return this.ready ? (this.invitation?.mode ?? null) : null;
  }

  get isController(): boolean {
    return this.mode === "control";
  }

  get isUploader(): boolean {
    return this.mode === "upload";
  }

  get trustedUntil(): number | null {
    return readTrustedDevice()?.expiresAt ?? null;
  }

  get hasTrustedDevice(): boolean {
    return readTrustedDevice() !== null;
  }

  readSpectrum(target: Uint8Array): boolean {
    if (!this.analysisAnalyser || !this.analysisData || this.audio.paused) return false;
    this.analysisAnalyser.getByteFrequencyData(this.analysisData);
    projectSpectrum(this.analysisData, target);
    return true;
  }

  async connect(mode: RemoteMode, password: string): Promise<void> {
    const existing = readTrustedDevice();
    const deviceId = existing?.deviceId ?? crypto.randomUUID();
    return this.connectWithTransportRecovery(mode, { kind: "password", password, deviceId });
  }

  async connectTrusted(mode: RemoteMode): Promise<void> {
    const trusted = readTrustedDevice();
    if (!trusted) throw new Error("Trusted browser access expired");
    try {
      await this.connectWithTransportRecovery(mode, { kind: "device", trusted });
    } catch (error) {
      clearTrustedDevice();
      throw error;
    }
  }

  private async connectWithTransportRecovery(mode: RemoteMode, auth: ConnectionAuth): Promise<void> {
    let lastError: unknown = new Error("Zuradio relay connection failed");
    for (let attempt = 0; attempt <= MAX_TRANSIENT_CONNECT_RETRIES; attempt += 1) {
      try {
        return await this.connectAttempt(mode, auth, 0, new Set());
      } catch (error) {
        lastError = error;
        if (!isTransientTransportFailure(error) || attempt === MAX_TRANSIENT_CONNECT_RETRIES) throw error;
        await this.disconnect();
        this.callbacks.onStatus("Connection interrupted; retrying…");
        await delay(retryDelay(attempt));
      }
    }
    throw lastError;
  }

  forgetTrustedDevice(): void {
    clearTrustedDevice();
  }

  private async connectAttempt(
    mode: RemoteMode,
    auth: ConnectionAuth,
    attempt: number,
    rejectedSessions: Set<string>,
  ): Promise<void> {
    await this.disconnect();
    this.connectionAuth = auth;
    this.requestedMode = mode;
    this.discoveryNonce = randomBase64Url(24);
    this.callbacks.onStatus("Finding Zuradio laptop…");
    const route = auth.kind === "password" ? await deriveRendezvousRoute(auth.password) : auth.trusted.route;
    this.connectionRoute = route;
    const rendezvous = createSdk(route.transportKey, "Zuradio password rendezvous");
    this.rendezvous = rendezvous;
    this.attachErrors(rendezvous);
    rendezvous.addEventListener(
      "dataReceived",
      ((event: VDONinjaEvent<"dataReceived">) => {
        if (!this.discoveryPeerUuids.has(event.detail.uuid)) return;
        this.handleRendezvousMessage(event.detail.data, rejectedSessions);
      }) as EventListener,
    );
    rendezvous.addEventListener(
      "dataChannelOpen",
      ((event: VDONinjaEvent<"dataChannelOpen">) => {
        if (this.discoveryPeerUuids.size >= MAX_RENDEZVOUS_PEERS) return;
        this.discoveryPeerUuids.add(event.detail.uuid);
        this.sendDiscovery(event.detail.uuid);
      }) as EventListener,
    );
    await rendezvous.connect();
    await rendezvous.joinRoom({ room: route.room, password: route.transportKey });
    const beacon = new Promise<CompanionInvitation>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.beaconWaiter?.timer === timer) this.beaconWaiter = null;
        reject(new Error("No active Zuradio broadcast found for this password"));
      }, auth.kind === "device" ? 6_000 : 20_000);
      this.beaconWaiter = { resolve, reject, timer };
    });
    try {
      await rendezvous.view(route.stream, {
        audio: false,
        video: false,
        dataOnly: true,
        downloads: false,
        allowresources: false,
        label: `Zuradio ${mode}`,
      });
      await this.ensureDiscovery();
      const invitation = await beacon;
      if (this.rendezvous === rendezvous) this.rendezvous = null;
      this.discoveryPeerUuids.clear();
      void rendezvous.disconnect().catch(() => undefined);
      this.invitation = invitation;
      this.callbacks.onStatus("Authenticating with laptop…");
      const control = createSdk(invitation.controllerTransportKey, `Zuradio ${mode}`);
      this.control = control;
      this.attachErrors(control);
      control.addEventListener(
        "dataReceived",
        ((event: VDONinjaEvent<"dataReceived">) => {
          if (this.control !== control || !this.controlPeerUuid || event.detail.uuid !== this.controlPeerUuid) return;
          void this.handleControlMessage(event.detail.data);
        }) as EventListener,
      );
      control.addEventListener(
        "dataChannelOpen",
        ((event: VDONinjaEvent<"dataChannelOpen">) => {
          if (this.control !== control) return;
          this.controlPeerUuid ??= event.detail.uuid;
          if (event.detail.uuid === this.controlPeerUuid) void this.sendHello(invitation);
        }) as EventListener,
      );
      const authenticationKey =
        auth.kind === "password"
          ? derivePasswordKey(auth.password, invitation.passwordSalt, invitation.passwordIterations)
          : Promise.resolve(new TextEncoder().encode(auth.trusted.token));
      const controlTransport = (async () => {
        await control.connect();
        await control.joinRoom({ room: invitation.controllerRoom, password: invitation.controllerTransportKey });
      })();
      const [derivedAuthenticationKey] = await Promise.all([authenticationKey, controlTransport]);
      this.authKey = derivedAuthenticationKey;
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (this.readyWaiter?.timer === timer) this.readyWaiter = null;
          reject(new Error("The laptop did not complete authentication"));
        }, 12_000);
        this.readyWaiter = { resolve, reject, timer };
      });
      await control.view(invitation.controllerStream, {
        audio: false,
        video: false,
        dataOnly: true,
        downloads: false,
        allowresources: false,
        label: `Zuradio ${mode}`,
      });
      await this.ensureHello(invitation);
      const helloRetry = window.setInterval(() => void this.sendHello(invitation), 1_000);
      try {
        await ready;
      } finally {
        window.clearInterval(helloRetry);
      }
    } catch (error) {
      const privateRouteWasReached = this.invitation !== null;
      const rejectedSession = this.invitation?.session ?? null;
      const reason = error instanceof Error ? error.message : "";
      const staleSession = reason.includes("session is not authorized");
      if (staleSession && rejectedSession) rejectedSessions.add(rejectedSession);
      await this.disconnect();
      const retryStaleSession = staleSession && attempt < MAX_STALE_SESSION_RETRIES;
      const retryTransientPasswordRoute =
        auth.kind === "password" && privateRouteWasReached && !staleSession && attempt < 1;
      if (retryStaleSession || retryTransientPasswordRoute) {
        this.callbacks.onStatus(
          retryStaleSession ? "Ignoring an old broadcast and finding this laptop…" : "Reconnecting to Zuradio laptop…",
        );
        await delay(retryStaleSession ? 250 : 600);
        return this.connectAttempt(mode, auth, attempt + 1, rejectedSessions);
      }
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
    let cataloguedCount = 0;
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
            cataloguedCount,
          });
        }
        const finished = await this.sendUpload({
          kind: "finish_file",
          transferId,
          fileId: entry.fileId,
          sha256: digest,
        });
        cataloguedCount += finished.outcome.imported.length;
        onProgress({
          fileName: entry.relativePath,
          fileIndex,
          fileCount: entries.length,
          fileReceived: bytes.length,
          fileSize: bytes.length,
          cataloguedCount,
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
    if (this.control && this.controlPeerUuid && this.grantId) {
      this.control.sendData(
        { type: "zuradio.goodbye", grantId: this.grantId, peerId: this.peerId },
        { uuid: this.controlPeerUuid, allowFallback: false },
      );
    }
    this.ready = false;
    this.helloSent = false;
    this.helloSending = false;
    this.sequence = 1;
    this.pendingServerProof = null;
    this.pendingHello = null;
    this.discoveryNonce = null;
    this.requestedMode = null;
    this.discoveryPeerUuids.clear();
    this.controlPeerUuid = null;
    this.grantId = null;
    this.authKey?.fill(0);
    this.authKey = null;
    this.connectionAuth = null;
    this.connectionRoute = null;
    if (this.readyWaiter) {
      clearTimeout(this.readyWaiter.timer);
      this.readyWaiter.reject(new Error("Remote connection closed"));
      this.readyWaiter = null;
    }
    if (this.beaconWaiter) {
      clearTimeout(this.beaconWaiter.timer);
      this.beaconWaiter.reject(new Error("Remote connection closed"));
      this.beaconWaiter = null;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Remote connection closed"));
    }
    this.pendingRequests.clear();
    this.audio.pause();
    this.audio.srcObject = null;
    this.analysisSource?.disconnect();
    this.analysisSource = null;
    this.analysisAnalyser = null;
    this.analysisData = null;
    const analysisContext = this.analysisContext;
    this.analysisContext = null;
    const listen = this.listen;
    const rendezvous = this.rendezvous;
    const control = this.control;
    this.listen = null;
    this.rendezvous = null;
    this.control = null;
    this.invitation = null;
    await Promise.allSettled([
      listen?.disconnect(),
      rendezvous?.disconnect(),
      control?.disconnect(),
      analysisContext?.close(),
    ]);
  }

  private async ensureDiscovery(): Promise<void> {
    for (let attempt = 0; attempt < 60 && this.beaconWaiter; attempt += 1) {
      if (this.sendDiscovery()) return;
      await delay(250);
    }
    if (this.beaconWaiter) throw new Error("The Zuradio rendezvous channel is not ready");
  }

  private sendDiscovery(peerUuid?: string): boolean {
    if (!this.rendezvous || !this.discoveryNonce || !this.requestedMode) return false;
    const peers = peerUuid ? [peerUuid] : [...this.discoveryPeerUuids];
    let sent = false;
    for (const uuid of peers) {
      sent =
        this.rendezvous.sendData(
          { type: "zuradio.discover", nonce: this.discoveryNonce, mode: this.requestedMode },
          { uuid, allowFallback: false },
        ) || sent;
    }
    return sent;
  }

  private handleRendezvousMessage(raw: unknown, rejectedSessions: ReadonlySet<string>): void {
    const message = parseMessage(raw);
    if (
      !message ||
      message.type !== "zuradio.beacon" ||
      !this.beaconWaiter ||
      !this.discoveryNonce ||
      !this.requestedMode ||
      message.nonce !== this.discoveryNonce ||
      message.mode !== this.requestedMode
    ) return;
    try {
      const invitation = beaconInvitation(message, this.requestedMode);
      if (rejectedSessions.has(invitation.session)) return;
      clearTimeout(this.beaconWaiter.timer);
      this.beaconWaiter.resolve(invitation);
      this.beaconWaiter = null;
    } catch {
      // Ignore malformed or unbound rendezvous responses and continue waiting.
    }
  }

  private async ensureHello(invitation: CompanionInvitation): Promise<void> {
    for (let attempt = 0; attempt < 40 && !this.helloSent && !this.ready; attempt += 1) {
      if (await this.sendHello(invitation)) return;
      await delay(250);
    }
    if (!this.helloSent && !this.ready) throw new Error("The laptop data channel is not ready");
  }

  private async sendHello(invitation: CompanionInvitation): Promise<boolean> {
    if (this.ready) return true;
    if (!this.control || !this.controlPeerUuid || !this.authKey || !this.connectionAuth || this.helloSending) {
      return false;
    }
    this.helloSending = true;
    try {
      if (!this.pendingHello) {
        const clientNonce = randomBase64Url(24);
        const auth = this.connectionAuth;
        const deviceId = auth.kind === "password" ? auth.deviceId : auth.trusted.deviceId;
        const transcript =
          auth.kind === "password"
            ? `zuradio/2|${invitation.session}|${invitation.epoch}|${invitation.mode}|${this.peerId}|${clientNonce}`
            : `zuradio/3|${invitation.session}|${invitation.epoch}|${invitation.mode}|${this.peerId}|${clientNonce}|device|${deviceId}`;
        const proof = await hmac(this.authKey, transcript);
        const serverProof = await hmac(this.authKey, `${transcript}|accepted`);
        this.pendingHello = {
          message: {
            type: "zuradio.hello",
            sessionId: invitation.session,
            mode: invitation.mode,
            peerId: this.peerId,
            clientNonce,
            proof,
            authKind: auth.kind,
            deviceId,
            ...(auth.kind === "device" ? { deviceToken: auth.trusted.token } : {}),
          },
          serverProof,
        };
      }
      const sent = this.control.sendData(
        this.pendingHello.message,
        { uuid: this.controlPeerUuid, allowFallback: false },
      );
      if (!sent) return false;
      this.pendingServerProof = this.pendingHello.serverProof;
      this.helloSent = true;
      return true;
    } finally {
      this.helloSending = false;
    }
  }

  private async handleControlMessage(raw: unknown): Promise<void> {
    const message = parseMessage(raw);
    if (!message) return;
    if (message.type === "zuradio.ready") {
      if (this.ready) return;
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
      this.pendingHello = null;
      this.grantId = stringField(message, "grantId", 256);
      if (
        this.connectionAuth?.kind === "password" &&
        this.connectionRoute &&
        isTrustedDeviceGrant(message.trustedDevice)
      ) {
        writeTrustedDevice({
          version: 1,
          deviceId: this.connectionAuth.deviceId,
          token: message.trustedDevice.token,
          expiresAt: message.trustedDevice.expiresAt * 1_000,
          route: this.connectionRoute,
        });
      }
      this.authKey?.fill(0);
      this.authKey = null;
      this.connectionAuth = null;
      this.connectionRoute = null;
      if (this.invitation.mode === "control") {
        if (!isSnapshot(message.snapshot)) throw new Error("Controller state is unavailable");
        this.revision = message.snapshot.revision;
        this.callbacks.onSnapshot(message.snapshot);
      } else if (this.invitation.mode === "listen" && isPublicState(message.state)) {
        this.callbacks.onNowPlaying(message.state);
      }
      const mode = this.invitation.mode;
      if (mode !== "upload" && !isAudioRoute(message.audio)) {
        throw new Error("Live audio route is unavailable");
      }
      if (mode === "control") {
        this.markReady(mode);
        void this.connectAudio(message.audio as AudioRoute).catch((error: unknown) => {
          this.callbacks.onError(error instanceof Error ? error.message : "Live audio connection failed");
        });
        return;
      }
      if (mode === "listen") await this.connectAudio(message.audio as AudioRoute);
      this.markReady(mode);
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
      if (!this.ready && this.readyWaiter) {
        clearTimeout(this.readyWaiter.timer);
        this.readyWaiter.reject(new Error(reason));
        this.readyWaiter = null;
        return;
      }
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

  private markReady(mode: RemoteMode): void {
    this.ready = true;
    this.callbacks.onStatus(
      mode === "control"
        ? "Controller connected"
        : mode === "upload"
          ? "Upload connected"
          : "Listening live",
    );
    if (this.readyWaiter) {
      clearTimeout(this.readyWaiter.timer);
      this.readyWaiter.resolve();
      this.readyWaiter = null;
    }
  }

  private async connectAudio(route: AudioRoute): Promise<void> {
    const listen = createSdk(route.transportKey, "Zuradio listener");
    this.listen = listen;
    this.attachErrors(listen);
    listen.addEventListener(
      "track",
      ((event: VDONinjaEvent<"track">) => {
        if (this.listen !== listen) return;
        if (event.detail.track.kind !== "audio") return;
        const stream = new MediaStream([event.detail.track]);
        this.audio.srcObject = stream;
        this.attachAudioAnalysis(stream);
        void this.audio.play().catch(() => {
          if (this.listen === listen && this.requestedMode !== "upload") {
            this.callbacks.onStatus("Tap play to hear the live stream");
          }
        });
      }) as EventListener,
    );
    listen.addEventListener(
      "dataReceived",
      ((event: VDONinjaEvent<"dataReceived">) => {
        if (this.listen !== listen) return;
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

  private prepareAudioAnalysis(): void {
    if (this.analysisContext) return;
    const context = new AudioContext({ latencyHint: "playback" });
    const analyser = context.createAnalyser();
    const silent = context.createGain();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.74;
    silent.gain.value = 0;
    analyser.connect(silent);
    silent.connect(context.destination);
    this.analysisContext = context;
    this.analysisAnalyser = analyser;
    this.analysisData = new Uint8Array(analyser.frequencyBinCount);
    void context.resume();
  }

  private attachAudioAnalysis(stream: MediaStream): void {
    this.prepareAudioAnalysis();
    if (!this.analysisContext || !this.analysisAnalyser) return;
    this.analysisSource?.disconnect();
    const source = this.analysisContext.createMediaStreamSource(stream);
    source.connect(this.analysisAnalyser);
    this.analysisSource = source;
  }

  private async sendUpload(operation: UploadOperation): Promise<RemoteUploadResponse> {
    if (!this.isUploader) throw new Error("Upload mode is not authenticated");
    return (await this.sendRequest("zuradio.upload", { operation }, 45_000)) as RemoteUploadResponse;
  }

  private sendRequest(type: string, payload: Record<string, unknown>, timeout = 10_000): Promise<unknown> {
    if (!this.control || !this.controlPeerUuid || !this.grantId || !this.ready) {
      return Promise.reject(new Error("Remote data channel is not ready"));
    }
    const control = this.control;
    const controlPeerUuid = this.controlPeerUuid;
    const grantId = this.grantId;
    const sequence = this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(sequence);
        reject(new Error("The laptop did not acknowledge the request"));
      }, timeout);
      this.pendingRequests.set(sequence, { resolve, reject, timer });
      const sent = control.sendData(
        { type, grantId, peerId: this.peerId, sequence, ...payload },
        { uuid: controlPeerUuid, allowFallback: false },
      );
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

function beaconInvitation(
  message: MessageRecord,
  mode: RemoteMode,
): CompanionInvitation {
  const epoch = numberField(message, "epoch");
  const passwordIterations = numberField(message, "passwordIterations");
  if (passwordIterations !== 210_000) throw new Error("Unsupported password protocol");
  return {
    version: "2",
    mode,
    session: stringField(message, "session", 64),
    epoch,
    controllerRoom: stringField(message, "controllerRoom", 128),
    controllerStream: stringField(message, "controllerStream", 128),
    controllerTransportKey: stringField(message, "controllerTransportKey", 128),
    passwordSalt: stringField(message, "passwordSalt", 128),
    passwordIterations,
  };
}

function projectSpectrum(source: Uint8Array, target: Uint8Array): void {
  const usable = Math.min(source.length, 104);
  for (let index = 0; index < target.length; index += 1) {
    const start = Math.floor((index / target.length) ** 1.7 * usable);
    const end = Math.max(start + 1, Math.floor(((index + 1) / target.length) ** 1.7 * usable));
    let peak = 0;
    for (let sourceIndex = start; sourceIndex < Math.min(end, usable); sourceIndex += 1) {
      peak = Math.max(peak, source[sourceIndex] ?? 0);
    }
    target[index] = peak;
  }
}

function isUploadResponse(value: unknown): value is RemoteUploadResponse {
  if (!value || typeof value !== "object") return false;
  const response = value as RemoteUploadResponse;
  return Boolean(response.outcome && typeof response.outcome.status === "string");
}

function isTrustedDeviceGrant(value: unknown): value is { token: string; expiresAt: number } {
  if (!value || typeof value !== "object") return false;
  const grant = value as { token?: unknown; expiresAt?: unknown };
  return (
    typeof grant.token === "string" &&
    grant.token.length > 32 &&
    grant.token.length <= 2_048 &&
    typeof grant.expiresAt === "number" &&
    Number.isSafeInteger(grant.expiresAt) &&
    grant.expiresAt * 1_000 > Date.now() &&
    grant.expiresAt * 1_000 <= Date.now() + TRUST_LIFETIME_MS + 5 * 60_000
  );
}

function readTrustedDevice(): StoredTrustedDevice | null {
  try {
    const raw = localStorage.getItem(TRUST_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredTrustedDevice>;
    const route = value.route;
    const valid =
      value.version === 1 &&
      typeof value.deviceId === "string" &&
      value.deviceId.length > 0 &&
      value.deviceId.length <= 128 &&
      typeof value.token === "string" &&
      value.token.length > 32 &&
      value.token.length <= 2_048 &&
      typeof value.expiresAt === "number" &&
      Number.isSafeInteger(value.expiresAt) &&
      value.expiresAt > Date.now() &&
      value.expiresAt <= Date.now() + TRUST_LIFETIME_MS + 5 * 60_000 &&
      route !== undefined &&
      [route.room, route.stream, route.transportKey].every(
        (field) => typeof field === "string" && field.length > 0 && field.length <= 128,
      );
    if (!valid) {
      clearTrustedDevice();
      return null;
    }
    return value as StoredTrustedDevice;
  } catch {
    clearTrustedDevice();
    return null;
  }
}

function writeTrustedDevice(device: StoredTrustedDevice): void {
  try {
    localStorage.setItem(TRUST_STORAGE_KEY, JSON.stringify(device));
  } catch {
    // Storage can be unavailable in a private browser; the live grant still works.
  }
}

function clearTrustedDevice(): void {
  try {
    localStorage.removeItem(TRUST_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in a private browser.
  }
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

function retryDelay(attempt: number): number {
  return 500 * (2 ** (attempt + 1) - 1);
}

function isTransientTransportFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return true;
  return /websocket|network|signaling|transport|room join timeout|remote connection closed|rendezvous channel is not ready|laptop did not complete authentication/i.test(
    error.message,
  );
}
