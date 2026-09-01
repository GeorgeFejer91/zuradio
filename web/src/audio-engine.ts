import type { AppSnapshot, PlayerState } from "./types";

const LOCAL_SEEK_INTENT_MS = 5_000;

export class AudioEngine {
  readonly element: HTMLAudioElement;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private broadcastDestination: MediaStreamAudioDestinationNode | null = null;
  private loadedTrackId: string | null = null;
  private canonicalTrackId: string | null = null;
  private canonicalPositionMs: number | null = null;
  private pendingPositionMs: number | null = null;
  private localSeekIntent: { trackId: string; positionMs: number; expiresAt: number } | null = null;
  private gestureUnlocked = false;

  constructor(
    private readonly mediaUrl: (trackId: string) => string,
    onEnded: () => void,
    onError: (message: string) => void,
    private readonly onTime: (milliseconds: number) => void,
  ) {
    this.element = document.createElement("audio");
    this.element.preload = "auto";
    this.element.crossOrigin = "use-credentials";
    this.element.addEventListener("ended", onEnded);
    this.element.addEventListener("error", () => onError("The current track could not be played."));
    this.element.addEventListener("loadedmetadata", () => this.applyPendingPosition());
    this.element.addEventListener("timeupdate", () => this.onTime(Math.round(this.element.currentTime * 1000)));
    document.body.append(this.element);
  }

  async unlock(): Promise<void> {
    this.ensureGraph();
    if (this.context?.state === "suspended") await this.context.resume();
    this.gestureUnlocked = true;
  }

  get broadcastStream(): MediaStream {
    this.ensureGraph();
    if (!this.broadcastDestination) throw new Error("Audio broadcast output is unavailable");
    return this.broadcastDestination.stream;
  }

  readSpectrum(target: Uint8Array): boolean {
    if (!this.analyser || !this.analyserData || this.element.paused) return false;
    this.analyser.getByteFrequencyData(this.analyserData);
    projectSpectrum(this.analyserData, target);
    return true;
  }

  async sync(snapshot: AppSnapshot, options: { forcePosition?: boolean } = {}): Promise<void> {
    const state = snapshot.player;
    const trackChanged = state.currentTrackId !== this.loadedTrackId;
    const canonicalPositionChanged =
      state.currentTrackId !== this.canonicalTrackId || state.positionMs !== this.canonicalPositionMs;
    this.canonicalTrackId = state.currentTrackId;
    this.canonicalPositionMs = state.positionMs;

    if (trackChanged) {
      this.loadedTrackId = state.currentTrackId;
      this.pendingPositionMs = null;
      if (this.localSeekIntent?.trackId !== state.currentTrackId) this.localSeekIntent = null;
      this.element.pause();
      if (state.currentTrackId) {
        this.element.src = this.mediaUrl(state.currentTrackId);
        this.element.load();
      } else {
        this.element.removeAttribute("src");
        this.element.load();
      }
    }
    this.applyVolume(state);

    let shouldApplyPosition =
      Boolean(state.currentTrackId) && (trackChanged || canonicalPositionChanged || options.forcePosition === true);
    if (this.localSeekIntent && state.currentTrackId === this.localSeekIntent.trackId) {
      if (state.positionMs === this.localSeekIntent.positionMs) {
        this.localSeekIntent = null;
        shouldApplyPosition = true;
      } else if (performance.now() < this.localSeekIntent.expiresAt) {
        shouldApplyPosition = false;
      } else {
        this.localSeekIntent = null;
      }
    } else if (this.localSeekIntent) {
      this.localSeekIntent = null;
    }
    if (state.currentTrackId && shouldApplyPosition) {
      this.applyPosition(state.positionMs);
    } else if (!state.currentTrackId && trackChanged) {
      this.pendingPositionMs = null;
      this.onTime(0);
    }

    if (state.status === "playing" && state.currentTrackId && this.gestureUnlocked) {
      try {
        await this.element.play();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        throw error;
      }
    } else if (state.status !== "buffering") {
      this.element.pause();
    }
  }

  seek(milliseconds: number): void {
    if (!this.loadedTrackId) return;
    const positionMs = Math.max(0, milliseconds);
    this.localSeekIntent = {
      trackId: this.loadedTrackId,
      positionMs,
      expiresAt: performance.now() + LOCAL_SEEK_INTENT_MS,
    };
    this.applyPosition(positionMs);
  }

  cancelLocalSeek(): void {
    this.localSeekIntent = null;
  }

  destroy(): void {
    this.element.pause();
    this.element.removeAttribute("src");
    this.element.remove();
    for (const track of this.broadcastDestination?.stream.getTracks() ?? []) track.stop();
    void this.context?.close();
    this.context = null;
    this.gain = null;
    this.analyser = null;
    this.analyserData = null;
    this.broadcastDestination = null;
    this.pendingPositionMs = null;
    this.localSeekIntent = null;
  }

  private applyPendingPosition(): void {
    if (this.pendingPositionMs !== null) this.applyPosition(this.pendingPositionMs);
  }

  private applyPosition(milliseconds: number): void {
    const requestedMs = Math.max(0, milliseconds);
    this.pendingPositionMs = requestedMs;
    this.onTime(requestedMs);
    if (!Number.isFinite(this.element.duration)) return;
    const durationMs = Math.max(0, this.element.duration * 1000);
    const positionMs = Math.min(requestedMs, durationMs || requestedMs);
    const targetSeconds = positionMs / 1000;
    if (Math.abs(this.element.currentTime - targetSeconds) > 0.15) {
      this.element.currentTime = targetSeconds;
    }
    this.pendingPositionMs = null;
    this.onTime(positionMs);
  }

  private ensureGraph(): void {
    if (this.context) return;
    const context = new AudioContext({ latencyHint: "playback" });
    const source = context.createMediaElementSource(this.element);
    const gain = context.createGain();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.74;
    const destination = context.createMediaStreamDestination();
    source.connect(gain);
    gain.connect(analyser);
    analyser.connect(context.destination);
    gain.connect(destination);
    this.context = context;
    this.gain = gain;
    this.analyser = analyser;
    this.analyserData = new Uint8Array(analyser.frequencyBinCount);
    this.broadcastDestination = destination;
  }

  private applyVolume(state: PlayerState): void {
    if (!this.gain) return;
    const value = state.muted ? 0 : state.volume / 100;
    this.gain.gain.setTargetAtTime(value, this.context?.currentTime ?? 0, 0.01);
  }
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
