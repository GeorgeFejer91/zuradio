export type PlaybackStatus = "stopped" | "paused" | "playing" | "buffering" | "error";
export type RepeatMode = "off" | "all" | "one";
export type Role = "local" | "controller" | "listener";
export type RecognitionStatus = "pending" | "recognized" | "no_match" | "unavailable" | "error";

export interface TrackRecognition {
  status: RecognitionStatus;
  provider: string | null;
  label: string | null;
  title: string | null;
  artist: string | null;
  album: string | null;
  genre: string | null;
  externalId: string | null;
  updatedAtMs: number | null;
}

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
  recognition: TrackRecognition;
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

export type ChatSender = "local" | "remote";

export interface ChatMessage {
  id: string;
  sender: ChatSender;
  text: string;
  sentAtMs: number;
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
  chatMessages?: ChatMessage[];
  player: PlayerState;
}

export type Action =
  | { kind: "play" }
  | { kind: "pause" }
  | { kind: "stop" }
  | { kind: "play_track"; trackId: string }
  | { kind: "seek"; positionMs: number; trackId: string }
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
  | { kind: "chat_post"; text: string }
  | { kind: "chat_delete"; messageId: string }
  | { kind: "chat_clear" }
  | {
      kind: "edit_track_metadata";
      trackId: string;
      title: string;
      artist: string;
      album: string;
      albumArtist: string;
      trackNumber: number | null;
      discNumber: number | null;
      year: number | null;
    }
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
  rendezvousRoom: string;
  rendezvousStream: string;
  rendezvousTransportKey: string;
  controllerRoom: string;
  controllerStream: string;
  controllerTransportKey: string;
  passwordSalt: string;
  passwordIterations: number;
}

export interface WireErrorShape {
  code: string;
  message: string;
  revision?: number;
}

export interface CompanionInvitation {
  version: "2";
  mode: RemoteMode;
  session: string;
  epoch: number;
  controllerRoom: string;
  controllerStream: string;
  controllerTransportKey: string;
  passwordSalt: string;
  passwordIterations: number;
}

export type RemoteMode = "listen" | "control" | "upload";

export interface UploadFileSpec {
  fileId: string;
  relativePath: string;
  size: number;
}

export type UploadOperation =
  | { kind: "begin"; transferId: string; files: UploadFileSpec[] }
  | { kind: "chunk"; transferId: string; fileId: string; offset: number; data: string }
  | { kind: "finish_file"; transferId: string; fileId: string; sha256: string }
  | { kind: "commit"; transferId: string }
  | { kind: "abort"; transferId: string };

export interface ImportedFile {
  title: string;
  artist: string;
  album: string;
  year: number | null;
  sha256?: string;
}

export interface UploadOutcome {
  status: string;
  transferId: string;
  fileId: string | null;
  received: number | null;
  imported: ImportedFile[];
}

export interface RemoteUploadResponse {
  outcome: UploadOutcome;
  snapshot: AppSnapshot | null;
}
