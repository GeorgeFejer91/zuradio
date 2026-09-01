import type {
  Action,
  ActionRequest,
  ActionResult,
  AppSnapshot,
  BroadcastSession,
  WireErrorShape,
} from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly revision?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class ZuradioApi {
  private snapshotValue: AppSnapshot | null = null;
  private socket: WebSocket | null = null;

  get currentSnapshot(): AppSnapshot | null {
    return this.snapshotValue;
  }

  async bootstrap(): Promise<AppSnapshot> {
    const parameters = new URLSearchParams(location.hash.slice(1));
    const token = parameters.get("bootstrap");
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    if (token) {
      const response = await this.request<{ snapshot: AppSnapshot }>("/api/v1/bootstrap", {
        method: "POST",
        body: JSON.stringify({ token }),
      });
      this.snapshotValue = response.snapshot;
      return response.snapshot;
    }
    return this.snapshot();
  }

  async snapshot(): Promise<AppSnapshot> {
    const snapshot = await this.request<AppSnapshot>("/api/v1/snapshot");
    this.snapshotValue = snapshot;
    return snapshot;
  }

  async scan(roots: string[] = []): Promise<AppSnapshot> {
    const snapshot = await this.request<AppSnapshot>("/api/v1/scan", {
      method: "POST",
      body: JSON.stringify({ roots }),
    });
    this.snapshotValue = snapshot;
    return snapshot;
  }

  async action(action: Action): Promise<ActionResult> {
    const current = this.snapshotValue;
    if (!current) throw new Error("Zuradio has not loaded yet");
    const request: ActionRequest = {
      protocol: 1,
      commandId: crypto.randomUUID(),
      expectedRevision: current.revision,
      actor: { role: "local", peerId: null },
      action,
    };
    try {
      const result = await this.request<ActionResult>("/api/v1/action", {
        method: "POST",
        body: JSON.stringify(request),
      });
      await this.snapshot();
      return result;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) await this.snapshot();
      throw error;
    }
  }

  async startBroadcast(): Promise<BroadcastSession> {
    return this.request<BroadcastSession>("/api/v1/broadcast/start", { method: "POST" });
  }

  async stopBroadcast(): Promise<void> {
    await this.request<void>("/api/v1/broadcast/stop", { method: "POST" });
  }

  async broadcastStatus(): Promise<BroadcastSession | null> {
    return this.request<BroadcastSession | null>("/api/v1/broadcast");
  }

  async verifyRemote(payload: unknown): Promise<unknown> {
    return this.request("/api/v1/remote/verify", {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  async remoteAction(payload: unknown): Promise<ActionResult> {
    const result = await this.request<ActionResult>("/api/v1/remote/action", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await this.snapshot();
    return result;
  }

  async remoteUpload(payload: unknown): Promise<unknown> {
    const result = await this.request<unknown>("/api/v1/remote/upload", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    await this.snapshot();
    return result;
  }

  subscribe(listener: (snapshot: AppSnapshot) => void): () => void {
    this.socket?.close();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${scheme}//${location.host}/api/v1/events`);
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      try {
        const snapshot = JSON.parse(String(event.data)) as AppSnapshot;
        this.snapshotValue = snapshot;
        listener(snapshot);
      } catch {
        // A malformed local event is ignored and the next canonical snapshot wins.
      }
    });
    return () => {
      if (this.socket === socket) this.socket = null;
      socket.close();
    };
  }

  mediaUrl(trackId: string): string {
    return `/api/v1/media/${encodeURIComponent(trackId)}`;
  }

  artworkUrl(trackId: string): string {
    return `/api/v1/artwork/${encodeURIComponent(trackId)}`;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {
      ...init,
      headers,
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!response.ok) {
      let wire: WireErrorShape = { code: "http_error", message: response.statusText };
      try {
        wire = (await response.json()) as WireErrorShape;
      } catch {
        // Keep the safe HTTP error when the response has no JSON body.
      }
      throw new ApiError(response.status, wire.code, wire.message, wire.revision);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }
}
