import type { AppSnapshot, PlayerState } from "./types";

export class AudioEngine {
  readonly element: HTMLAudioElement;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private analyserData: Uint8Array<ArrayBuffer> | null = null;
  private broadcastDestination: MediaStreamAudioDestinationNode | null = null;
  private loadedTrackId: string | null = null;
  private gestureUnlocked = false;

  constructor(
    private readonly mediaUrl: (trackId: string) => string,
    onEnded: () => void,
    onError: (message: string) => void,
    onTime: (milliseconds: number) => void,
  ) {
    this.element = document.createElement("audio");
    this.element.preload = "auto";
    this.element.crossOrigin = "use-credentials";
    this.element.addEventListener("ended", onEnded);
    this.element.addEventListener("error", () => onError("The current track could not be played."));
    this.element.addEventListener("timeupdate", () => onTime(Math.round(this.element.currentTime * 1000)));
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

  async sync(snapshot: AppSnapshot): Promise<void> {
    const state = snapshot.player;
    if (state.currentTrackId !== this.loadedTrackId) {
      this.loadedTrackId = state.currentTrackId;
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
    const targetSeconds = state.positionMs / 1000;
    if (
      state.currentTrackId &&
      Number.isFinite(this.element.duration) &&
      Math.abs(this.element.currentTime - targetSeconds) > 2.5
    ) {
      this.element.currentTime = Math.min(targetSeconds, this.element.duration || targetSeconds);
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
    this.element.currentTime = Math.max(0, milliseconds / 1000);
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
