export type PlaybackStatus = "stopped" | "paused" | "playing" | "buffering" | "error";
export type RepeatMode = "off" | "all" | "one";
export type Role = "local" | "controller" | "listener";

export interface Track {
  id: string;
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNumber: number | null;
  discNumber: number | null;
  year: number | null;
  durationMs: number;
  format: string;
  available: boolean;
  hasArtwork: boolean;
}

export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

export interface HistoryEntry {
  trackId: string;
  playedAtMs: number;
}

export interface PlayerState {
  status: PlaybackStatus;
  currentTrackId: string | null;
  positionMs: number;
  volume: number;
  muted: boolean;
  shuffle: boolean;
  repeat: RepeatMode;
  queue: string[];
  queueBeforeShuffle: string[] | null;
  queueCursor: number | null;
  lastError: string | null;
}

export interface AppSnapshot {
  protocol: number;
  revision: number;
  tracks: Track[];
  playlists: Playlist[];
  favorites: string[];
  history: HistoryEntry[];
  player: PlayerState;
}

export type Action =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "stop" }
  | { kind: "play_track"; trackId: string }
  | { kind: "seek"; positionMs: number }
  | { kind: "next" }
  | { kind: "previous" }
  | { kind: "set_volume"; volume: number }
  | { kind: "set_muted"; muted: boolean }
  | { kind: "set_shuffle"; enabled: boolean }
  | { kind: "set_repeat"; mode: RepeatMode }
  | { kind: "queue_add"; trackId: string }
  | { kind: "queue_remove"; index: number }
  | { kind: "queue_move"; from: number; to: number }
  | { kind: "queue_clear" }
  | { kind: "playlist_create"; name: string }
  | { kind: "playlist_rename"; playlistId: string; name: string }
  | { kind: "playlist_delete"; playlistId: string }
  | { kind: "playlist_add"; playlistId: string; trackId: string }
  | { kind: "playlist_remove"; playlistId: string; index: number }
  | { kind: "playlist_move"; playlistId: string; from: number; to: number }
  | { kind: "favorite_set"; trackId: string; favorite: boolean }
  | {
      kind: "report_playback";
      status: PlaybackStatus;
      positionMs: number;
      error: string | null;
    };

export interface ActionRequest {
  protocol: 1;
  commandId: string;
  expectedRevision: number | null;
  actor: { role: Role; peerId: string | null };
  action: Action;
}

export interface ActionResult {
  commandId: string;
  revision: number;
  applied: boolean;
}

export interface BroadcastSession {
  sessionId: string;
  epoch: number;
  listenRoom: string;
  listenStream: string;
  listenTransportKey: string;
  controllerRoom: string;
  controllerStream: string;
  controllerTransportKey: string;
  controllerPairingKey: string;
  listenerInvitation: string;
  controllerInvitation: string;
}

export interface WireErrorShape {
  code: string;
  message: string;
  revision?: number;
}

export interface CompanionInvitation {
  version: "1";
  role: "listener" | "controller";
  session: string;
  epoch: number;
  listenRoom: string;
  listenStream: string;
  listenTransportKey: string;
  controllerRoom?: string;
  controllerStream?: string;
  controllerTransportKey?: string;
  pairingKey?: string;
}
