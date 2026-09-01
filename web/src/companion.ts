import "./style.css";

import type { Action, AppSnapshot, CompanionInvitation, ImportedFile, Playlist } from "./types";
import { parseInvitation } from "./invitation";
import { isSupportedAudioFileName, SUPPORTED_AUDIO_ACCEPT } from "./formats";
import { CompanionBridge, type PublicNowPlaying } from "./vdo";

type ControllerView = "library" | "queue" | "playlists";
const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Missing app root");
const root: HTMLDivElement = rootElement;

if (window.top !== window.self) {
  root.innerHTML = `<main class="companion-shell"><h1>Zuradio Web Companion</h1><p class="notice error">Open this invitation directly. Zuradio does not run inside another page.</p></main>`;
  throw new Error("Framed companion refused");
}

const audio = document.createElement("audio");
audio.controls = true;
audio.preload = "none";
audio.setAttribute("aria-label", "Live Zuradio audio");

let invitation: CompanionInvitation | null = null;
let snapshot: AppSnapshot | null = null;
let publicState: PublicNowPlaying | null = null;
let connectionStatus = "Laptop offline";
let errorMessage = "";
let connected = false;
let busy = false;
let view: ControllerView = "library";
let search = "";
let invitationInput = "";
let selectedFiles: File[] = [];
let uploadProgress = "";
let importedFiles: ImportedFile[] = [];
let selectedPlaylistId: string | null = null;
let pendingPlaylistSelection: Set<string> | null = null;

try {
  if (location.hash.length > 1) invitation = parseInvitation(location.hash);
} catch (error) {
  errorMessage = messageOf(error);
}
history.replaceState(null, "", `${location.pathname}${location.search}`);

const bridge = new CompanionBridge(audio, {
  onSnapshot(value) {
    snapshot = value;
    if (pendingPlaylistSelection) {
      const created = value.playlists.find((playlist) => !pendingPlaylistSelection?.has(playlist.id));
      if (created) {
        selectedPlaylistId = created.id;
        pendingPlaylistSelection = null;
      }
    }
    selectedPlaylistId ??= value.playlists[0]?.id ?? null;
    render();
  },
  onNowPlaying(value) {
    publicState = value;
    render();
  },
  onStatus(value) {
    connectionStatus = value;
    connected = value === "Listening live" || value === "Controller connected" || value === "Upload connected";
    render();
  },
  onError(value) {
    errorMessage = value;
    render();
  },
});

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target || busy) return;
  void handleClick(target);
});

root.addEventListener("input", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.matches("[data-search]")) {
    search = input.value;
    render();
  } else if (input.matches("[data-invitation]")) {
    invitationInput = input.value;
  }
});

root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.matches("[data-volume]")) void send({ kind: "set_volume", volume: Number(input.value) });
  if (input.matches("[data-seek]")) void send({ kind: "seek", positionMs: Number(input.value) });
  if (input.matches("[data-upload-files], [data-upload-folder]")) {
    selectedFiles = Array.from(input.files ?? []).filter(isSupportedUpload);
    importedFiles = [];
    uploadProgress = "";
    render();
  }
});

root.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (!form.matches("[data-playlist-form]")) return;
  event.preventDefault();
  const input = form.elements.namedItem("playlistName") as HTMLInputElement;
  const name = input.value.trim();
  if (name) void createPlaylist(name);
});

render();

async function handleClick(target: HTMLElement): Promise<void> {
  const name = target.dataset.action;
  if (!name) return;
  if (name === "connect") {
    await connect();
    return;
  }
  if (name === "disconnect") {
    busy = true;
    render();
    await bridge.disconnect();
    connected = false;
    connectionStatus = "Disconnected";
    snapshot = null;
    selectedFiles = [];
    importedFiles = [];
    uploadProgress = "";
    busy = false;
    render();
    return;
  }
  if (name === "upload") {
    await uploadSelectedFiles();
    return;
  }
  if (name === "view") {
    view = target.dataset.view as ControllerView;
    render();
    return;
  }
  if (name === "select-playlist") {
    selectedPlaylistId = target.dataset.playlistId ?? null;
    render();
    return;
  }
  if (name === "rename-playlist") {
    const playlist = playlistById(target.dataset.playlistId);
    const value = playlist ? window.prompt("Rename playlist", playlist.name) : null;
    if (playlist && value?.trim()) await send({ kind: "playlist_rename", playlistId: playlist.id, name: value });
    return;
  }
  if (name === "delete-playlist") {
    const playlist = playlistById(target.dataset.playlistId);
    if (playlist && window.confirm(`Delete “${playlist.name}”?`)) {
      await send({ kind: "playlist_delete", playlistId: playlist.id });
    }
    return;
  }
  const trackId = target.dataset.trackId;
  const playlistId = target.dataset.playlistId;
  const index = numeric(target.dataset.index);
  const from = numeric(target.dataset.from);
  const to = numeric(target.dataset.to);
  switch (name) {
    case "play":
      await send({ kind: "play" });
      break;
    case "pause":
      await send({ kind: "pause" });
      break;
    case "stop":
      await send({ kind: "stop" });
      break;
    case "previous":
      await send({ kind: "previous" });
      break;
    case "next":
      await send({ kind: "next" });
      break;
    case "mute":
      if (snapshot) await send({ kind: "set_muted", muted: !snapshot.player.muted });
      break;
    case "shuffle":
      if (snapshot) await send({ kind: "set_shuffle", enabled: !snapshot.player.shuffle });
      break;
    case "repeat":
      if (snapshot) {
        const modes = ["off", "all", "one"] as const;
        const current = modes.indexOf(snapshot.player.repeat);
        await send({ kind: "set_repeat", mode: modes[(current + 1) % modes.length] ?? "off" });
      }
      break;
    case "play-track":
      if (trackId) await send({ kind: "play_track", trackId });
      break;
    case "queue-add":
      if (trackId) await send({ kind: "queue_add", trackId });
      break;
    case "queue-remove":
      if (index !== null) await send({ kind: "queue_remove", index });
      break;
    case "queue-move":
      if (from !== null && to !== null) await send({ kind: "queue_move", from, to });
      break;
    case "queue-clear":
      await send({ kind: "queue_clear" });
      break;
    case "favorite":
      if (trackId) await send({ kind: "favorite_set", trackId, favorite: target.dataset.enabled === "true" });
      break;
    case "playlist-add":
      if (playlistId && trackId) await send({ kind: "playlist_add", playlistId, trackId });
      break;
    case "playlist-remove":
      if (playlistId && index !== null) await send({ kind: "playlist_remove", playlistId, index });
      break;
    case "playlist-move":
      if (playlistId && from !== null && to !== null) await send({ kind: "playlist_move", playlistId, from, to });
      break;
  }
}

async function connect(): Promise<void> {
  errorMessage = "";
  if (!invitation) {
    const input = root.querySelector<HTMLInputElement>("[data-invitation]");
    try {
      const value = invitationInput.trim() || input?.value.trim() || "";
      const url = new URL(value);
      invitation = parseInvitation(url.hash);
      invitationInput = "";
    } catch (error) {
      errorMessage = messageOf(error) || "Paste a complete Zuradio invitation";
      render();
      return;
    }
  }
  busy = true;
  const passwordInput = root.querySelector<HTMLInputElement>("[data-password]");
  const password = passwordInput?.value ?? "";
  if (passwordInput) passwordInput.value = "";
  render();
  try {
    await bridge.connect(invitation, password);
    connected = true;
  } catch (error) {
    errorMessage = messageOf(error);
    connected = false;
  } finally {
    busy = false;
    render();
  }
}

async function uploadSelectedFiles(): Promise<void> {
  if (!selectedFiles.length) return;
  busy = true;
  errorMessage = "";
  importedFiles = [];
  render();
  try {
    const outcome = await bridge.uploadFiles(selectedFiles, (progress) => {
      const percent = Math.round((progress.fileReceived / progress.fileSize) * 100);
      uploadProgress = `${progress.fileIndex + 1}/${progress.fileCount} · ${progress.fileName} · ${percent}%`;
      render();
    });
    importedFiles = outcome.imported;
    uploadProgress = `${outcome.imported.length} track${outcome.imported.length === 1 ? "" : "s"} added to the laptop library`;
    selectedFiles = [];
  } catch (error) {
    errorMessage = messageOf(error);
  } finally {
    busy = false;
    render();
  }
}

async function send(action: Action): Promise<boolean> {
  busy = true;
  errorMessage = "";
  render();
  try {
    await bridge.send(action);
    return true;
  } catch (error) {
    errorMessage = messageOf(error);
    return false;
  } finally {
    busy = false;
    render();
  }
}

async function createPlaylist(name: string): Promise<void> {
  pendingPlaylistSelection = new Set(snapshot?.playlists.map((playlist) => playlist.id) ?? []);
  if (!(await send({ kind: "playlist_create", name }))) pendingPlaylistSelection = null;
}

function render(): void {
  const mode = invitation?.mode ?? null;
  root.innerHTML = `<main class="companion-shell" aria-busy="${busy}">
    <header class="companion-header"><h1>Zuradio Web Companion</h1><span class="muted">${mode ? capitalize(mode) : "No invitation"}</span></header>
    ${errorMessage ? `<p class="notice error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
    <section class="connection-panel">
      <div class="section-header"><div><h2>Connection</h2><p class="muted">${escapeHtml(connectionStatus)}</p></div>
        ${connected ? `<button data-action="disconnect" ${disabled()}>Disconnect</button>` : `<button class="primary" data-action="connect" data-testid="connect" ${disabled()}>Connect</button>`}
      </div>
      ${!invitation ? `<label for="invitation">Invitation link</label><input id="invitation" data-invitation type="url" autocomplete="off" spellcheck="false" value="${escapeAttribute(invitationInput)}" placeholder="Paste the link from the Zuradio laptop" />` : `<p class="muted">The invitation is held in memory only. Its URL fragment has been removed from the address bar.</p>`}
      ${!connected ? `<label for="password">Zuradio password</label><input id="password" data-password data-testid="password" type="password" minlength="8" maxlength="256" autocomplete="current-password" required placeholder="Password stored on the laptop" />` : ""}
    </section>
    ${mode !== "upload" ? `<section class="companion-player">
      <h2>Now playing</h2>
      ${renderNowPlaying()}
      <div data-audio-mount></div>
      ${bridge.isController && snapshot ? renderTransport(snapshot) : ""}
    </section>` : ""}
    ${bridge.isController && snapshot ? renderController(snapshot) : ""}
    ${bridge.isUploader ? renderUpload() : ""}
    ${mode === "listen" ? `<p class="muted">Listen access is read-only. This page has no player, queue, playlist, or upload controls.</p>` : ""}
  </main>`;
  root.querySelector("[data-audio-mount]")?.append(audio);
}

function renderUpload(): string {
  return `<section class="upload-panel">
    <div class="section-header"><div><h2>Add music to this laptop</h2><p class="muted">Files travel directly through the encrypted live bridge. GitHub Pages never stores the music.</p></div></div>
    <div class="upload-picker">
      <label class="button" for="upload-files">Choose files</label>
      <input id="upload-files" data-upload-files type="file" multiple accept="${SUPPORTED_AUDIO_ACCEPT}" />
      <label class="button" for="upload-folder">Choose folder</label>
      <input id="upload-folder" data-upload-folder type="file" multiple webkitdirectory />
    </div>
    <p class="muted">${selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected` : "Choose individual audio files or an entire folder."}</p>
    <button class="primary" data-action="upload" data-testid="upload" ${selectedFiles.length && !busy ? "" : "disabled"}>Upload to Zuradio</button>
    ${uploadProgress ? `<p class="upload-progress" role="status">${escapeHtml(uploadProgress)}</p>` : ""}
    ${importedFiles.length ? `<ol class="imported-list">${importedFiles.map((file) => `<li><strong>${escapeHtml(file.title)}</strong><span>${escapeHtml(file.artist)} · ${escapeHtml(file.album)}${file.year ? ` · ${file.year}` : ""}</span></li>`).join("")}</ol>` : ""}
  </section>`;
}

function renderNowPlaying(): string {
  const currentTrack = snapshot?.tracks.find((track) => track.id === snapshot?.player.currentTrackId);
  const title = currentTrack?.title ?? publicState?.track?.title ?? "Nothing playing";
  const artist = currentTrack?.artist ?? publicState?.track?.artist ?? "Waiting for the laptop";
  return `<div class="now-playing"><strong data-testid="companion-title">${escapeHtml(title)}</strong><span>${escapeHtml(artist)}</span></div>`;
}

function renderTransport(state: AppSnapshot): string {
  const track = state.tracks.find((candidate) => candidate.id === state.player.currentTrackId);
  const playing = state.player.status === "playing";
  return `<div class="companion-transport" aria-label="Remote player controls">
    <button data-action="previous" aria-label="Previous">⏮</button>
    <button class="primary" data-action="${playing ? "pause" : "play"}" data-testid="remote-play-pause">${playing ? "Pause" : "Play"}</button>
    <button data-action="next" aria-label="Next">⏭</button>
    <button data-action="stop">Stop</button>
    <button class="${state.player.shuffle ? "active" : ""}" data-action="shuffle" aria-pressed="${state.player.shuffle}">Shuffle</button>
    <button class="${state.player.repeat !== "off" ? "active" : ""}" data-action="repeat" aria-label="Repeat mode: ${state.player.repeat}">Repeat ${state.player.repeat}</button>
    <button data-action="mute">${state.player.muted ? "Unmute" : "Mute"}</button>
    <input data-volume type="range" min="0" max="100" value="${state.player.volume}" aria-label="Laptop volume" />
    <input data-seek type="range" min="0" max="${Math.max(track?.durationMs ?? 0, 1)}" value="${Math.min(state.player.positionMs, track?.durationMs ?? 0)}" aria-label="Seek position" ${track ? "" : "disabled"} />
  </div>`;
}

function renderController(state: AppSnapshot): string {
  return `<section class="controller-panel">
    <nav class="nav" aria-label="Controller sections">
      ${(["library", "queue", "playlists"] as ControllerView[])
        .map((item) => `<button data-action="view" data-view="${item}" aria-current="${view === item ? "page" : "false"}">${capitalize(item)}</button>`)
        .join("")}
    </nav>
    ${view === "library" ? renderLibrary(state) : view === "queue" ? renderQueue(state) : renderPlaylists(state)}
  </section>`;
}

function renderLibrary(state: AppSnapshot): string {
  const query = search.trim().toLocaleLowerCase();
  const tracks = state.tracks.filter((track) =>
    !query || [track.title, track.artist, track.album].some((value) => value.toLocaleLowerCase().includes(query)),
  );
  const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? state.playlists[0];
  return `<input class="search" data-search type="search" value="${escapeAttribute(search)}" placeholder="Search library" aria-label="Search library" />
    <ol class="track-list">${tracks
      .map(
        (track) => `<li class="track-row">
          <button class="icon" data-action="play-track" data-track-id="${escapeAttribute(track.id)}" aria-label="Play ${escapeAttribute(track.title)}">▶</button>
          <div class="track-title"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></div>
          <div class="track-cell track-artist">${escapeHtml(track.artist)}</div>
          <div class="track-cell track-album">${escapeHtml(track.album)}</div>
          <div class="track-duration">${formatTime(track.durationMs)}</div>
          <div class="track-actions">
            <button data-action="favorite" data-track-id="${escapeAttribute(track.id)}" data-enabled="${!state.favorites.includes(track.id)}" aria-label="${state.favorites.includes(track.id) ? "Remove from" : "Add to"} favorites">${state.favorites.includes(track.id) ? "★" : "☆"}</button>
            <button data-action="queue-add" data-track-id="${escapeAttribute(track.id)}" aria-label="Add ${escapeAttribute(track.title)} to queue">＋</button>
            ${selected ? `<button data-action="playlist-add" data-playlist-id="${escapeAttribute(selected.id)}" data-track-id="${escapeAttribute(track.id)}" aria-label="Add to ${escapeAttribute(selected.name)}">↳</button>` : ""}
          </div>
        </li>`,
      )
      .join("")}</ol>`;
}

function renderQueue(state: AppSnapshot): string {
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  return `<div class="section-header"><h2>Queue</h2><button data-action="queue-clear" ${state.player.queue.length ? "" : "disabled"}>Clear</button></div>
    <ol class="queue-list">${state.player.queue
      .map((id, index) => {
        const track = byId.get(id);
        const title = track?.title ?? "Unavailable";
        return `<li class="queue-item${index === state.player.queueCursor ? " current" : ""}"><span>${index + 1}</span><span class="track-title"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(track?.artist ?? "")}</span></span><span class="queue-buttons"><button data-action="queue-move" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move ${escapeAttribute(title)} up" ${index === 0 ? "disabled" : ""}>↑</button><button data-action="queue-move" data-from="${index}" data-to="${Math.min(state.player.queue.length - 1, index + 1)}" aria-label="Move ${escapeAttribute(title)} down" ${index === state.player.queue.length - 1 ? "disabled" : ""}>↓</button><button data-action="queue-remove" data-index="${index}" aria-label="Remove ${escapeAttribute(title)} from queue">×</button></span></li>`;
      })
      .join("")}</ol>`;
}

function renderPlaylists(state: AppSnapshot): string {
  const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? state.playlists[0];
  if (selected) selectedPlaylistId = selected.id;
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  return `<form class="inline-form" data-playlist-form><input name="playlistName" maxlength="80" required placeholder="New playlist" aria-label="New playlist name" /><button class="primary">Create</button></form>
    <div class="playlist-layout"><ul class="playlist-list">${state.playlists
      .map((playlist) => `<li><button class="select-playlist${playlist.id === selected?.id ? " selected" : ""}" data-action="select-playlist" data-playlist-id="${escapeAttribute(playlist.id)}">${escapeHtml(playlist.name)}</button><span class="row-actions"><button data-action="rename-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-label="Rename ${escapeAttribute(playlist.name)}">✎</button><button data-action="delete-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-label="Delete ${escapeAttribute(playlist.name)}">×</button></span></li>`)
      .join("")}</ul>
      <ol class="queue-list">${(selected?.trackIds ?? [])
        .map((id, index) => {
          const title = byId.get(id)?.title ?? "Unavailable";
          return `<li class="queue-item"><span>${index + 1}</span><span class="track-title"><strong>${escapeHtml(title)}</strong></span><span class="queue-buttons"><button data-action="playlist-move" data-playlist-id="${escapeAttribute(selected?.id ?? "")}" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move ${escapeAttribute(title)} up" ${index === 0 ? "disabled" : ""}>↑</button><button data-action="playlist-move" data-playlist-id="${escapeAttribute(selected?.id ?? "")}" data-from="${index}" data-to="${Math.min((selected?.trackIds.length ?? 1) - 1, index + 1)}" aria-label="Move ${escapeAttribute(title)} down" ${index === (selected?.trackIds.length ?? 1) - 1 ? "disabled" : ""}>↓</button><button data-action="playlist-remove" data-playlist-id="${escapeAttribute(selected?.id ?? "")}" data-index="${index}" aria-label="Remove ${escapeAttribute(title)} from playlist">×</button></span></li>`;
        })
        .join("")}</ol></div>`;
}

function playlistById(id: string | undefined): Playlist | undefined {
  return snapshot?.playlists.find((playlist) => playlist.id === id);
}

function numeric(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function disabled(): string {
  return busy ? "disabled" : "";
}

function formatTime(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character] ?? character);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Connection failed";
}

function isSupportedUpload(file: File): boolean {
  return isSupportedAudioFileName(file.name);
}

window.addEventListener("pagehide", () => void bridge.disconnect());
