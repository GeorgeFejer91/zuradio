import "./style.css";

import type { Action, AppSnapshot, ImportedFile, Playlist, RemoteMode } from "./types";
import { isSupportedAudioFileName, SUPPORTED_AUDIO_ACCEPT } from "./formats";
import { icon, type IconName } from "./icons";
import { CompanionBridge, type PublicNowPlaying } from "./vdo";
import { renderSoundVisualizer, SvgSoundVisualizer } from "./visualizer";

type ControllerView = "library" | "queue" | "playlists";
const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Missing app root");
const root: HTMLDivElement = rootElement;

if (window.top !== window.self) {
  root.innerHTML = `<main class="companion-shell"><h1>Zuradio Web Companion</h1><p class="notice error">Open Zuradio directly. The companion does not run inside another page.</p></main>`;
  throw new Error("Framed companion refused");
}

const audio = document.createElement("audio");
audio.controls = false;
audio.preload = "none";
audio.setAttribute("playsinline", "");
audio.setAttribute("aria-label", "Live Zuradio audio");

let snapshot: AppSnapshot | null = null;
let publicState: PublicNowPlaying | null = null;
let connectionStatus = "Laptop offline";
let errorMessage = "";
let connected = false;
let busy = false;
let view: ControllerView = "library";
let search = "";
let selectedMode: RemoteMode | null = null;
let dialogMode: RemoteMode | null = null;
let selectedFiles: File[] = [];
let uploadProgress = "";
let importedFiles: ImportedFile[] = [];
let selectedPlaylistId: string | null = null;
let pendingPlaylistSelection: Set<string> | null = null;
let playlistPickerOpen = false;
let playlistSearch = "";
let renamingPlaylistId: string | null = null;
let commandTail: Promise<void> = Promise.resolve();

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
    render();
  },
  onError(value) {
    errorMessage = value;
    render();
  },
});
const visualizer = new SvgSoundVisualizer();
audio.addEventListener("play", render);
audio.addEventListener("pause", render);
audio.addEventListener("volumechange", render);

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
  } else if (input.matches("[data-playlist-search]")) {
    playlistSearch = input.value;
    render();
  }
});

root.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement;
  if (input.matches("[data-volume]")) void send({ kind: "set_volume", volume: Number(input.value) });
  if (input.matches("[data-seek]")) void send({ kind: "seek", positionMs: Number(input.value) });
  if (input.matches("[data-stream-volume]")) audio.volume = Number(input.value) / 100;
  if (input.matches("[data-upload-files], [data-upload-folder]")) {
    selectedFiles = Array.from(input.files ?? []).filter(isSupportedUpload);
    importedFiles = [];
    uploadProgress = "";
    render();
  }
});

root.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  if (form.matches("[data-connect-form]")) {
    event.preventDefault();
    const mode = form.dataset.mode as RemoteMode;
    const password = (form.elements.namedItem("password") as HTMLInputElement).value;
    void connect(mode, password);
    return;
  }
  if (form.matches("[data-rename-playlist-form]")) {
    event.preventDefault();
    const playlistId = form.dataset.playlistId;
    const name = (form.elements.namedItem("playlistName") as HTMLInputElement).value.trim();
    if (playlistId && name) void renamePlaylist(playlistId, name);
    return;
  }
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
  if (name === "choose-mode") {
    const mode = target.dataset.mode as RemoteMode;
    errorMessage = "";
    if (bridge.hasTrustedDevice) {
      await connectTrusted(mode);
      return;
    }
    dialogMode = mode;
    render();
    root.querySelector<HTMLInputElement>("[data-password]")?.focus();
    return;
  }
  if (name === "switch-mode") {
    const mode = target.dataset.mode as RemoteMode;
    if (mode !== selectedMode || bridge.mode !== mode) await connectTrusted(mode, true);
    return;
  }
  if (name === "forget-device") {
    bridge.forgetTrustedDevice();
    errorMessage = "This browser will ask for the Zuradio password next time.";
    render();
    return;
  }
  if (name === "cancel-connect") {
    dialogMode = null;
    errorMessage = "";
    render();
    return;
  }
  if (name === "disconnect") {
    busy = true;
    render();
    await bridge.disconnect();
    connected = false;
    selectedMode = null;
    dialogMode = null;
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
  if (name === "toggle-stream-audio") {
    if (audio.paused) await audio.play();
    else audio.pause();
    return;
  }
  if (name === "toggle-stream-mute") {
    audio.muted = !audio.muted;
    return;
  }
  if (name === "view") {
    view = target.dataset.view as ControllerView;
    render();
    return;
  }
  if (name === "select-playlist") {
    selectedPlaylistId = target.dataset.playlistId ?? null;
    playlistPickerOpen = false;
    render();
    return;
  }
  if (name === "rename-playlist") {
    const playlist = playlistById(target.dataset.playlistId);
    renamingPlaylistId = playlist?.id ?? null;
    render();
    root.querySelector<HTMLInputElement>("[data-rename-playlist]")?.select();
    return;
  }
  if (name === "cancel-rename") {
    renamingPlaylistId = null;
    render();
    return;
  }
  if (name === "toggle-playlist-picker") {
    playlistPickerOpen = !playlistPickerOpen;
    playlistSearch = "";
    render();
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

async function connect(mode: RemoteMode, password: string): Promise<void> {
  errorMessage = "";
  busy = true;
  selectedMode = mode;
  render();
  try {
    await bridge.connect(mode, password);
    connected = true;
    errorMessage = "";
    dialogMode = null;
  } catch (error) {
    errorMessage = messageOf(error);
    connected = false;
    dialogMode = mode;
  } finally {
    busy = false;
    render();
  }
}

async function connectTrusted(mode: RemoteMode, switching = false): Promise<void> {
  errorMessage = "";
  busy = true;
  selectedMode = mode;
  dialogMode = null;
  if (switching) connectionStatus = `Switching to ${capitalize(mode)}…`;
  render();
  try {
    await bridge.connectTrusted(mode);
    connected = true;
  } catch {
    errorMessage = "Trusted access expired. Enter the Zuradio password again.";
    connected = false;
    dialogMode = mode;
  } finally {
    busy = false;
    render();
    if (dialogMode) root.querySelector<HTMLInputElement>("[data-password]")?.focus();
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

function send(action: Action): Promise<boolean> {
  const operation = commandTail.then(
    () => sendNow(action),
    () => sendNow(action),
  );
  commandTail = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function sendNow(action: Action): Promise<boolean> {
  errorMessage = "";
  try {
    await bridge.send(action);
    return true;
  } catch (error) {
    errorMessage = messageOf(error);
    render();
    return false;
  }
}

async function createPlaylist(name: string): Promise<void> {
  pendingPlaylistSelection = new Set(snapshot?.playlists.map((playlist) => playlist.id) ?? []);
  if (!(await send({ kind: "playlist_create", name }))) pendingPlaylistSelection = null;
}

async function renamePlaylist(playlistId: string, name: string): Promise<void> {
  if (await send({ kind: "playlist_rename", playlistId, name })) renamingPlaylistId = null;
  render();
}

function render(): void {
  const mode = selectedMode ?? bridge.mode;
  root.innerHTML = `<main class="companion-shell ${connected ? `is-connected is-${mode ?? "listen"}` : "is-landing"}" aria-busy="${busy}">
    <header class="companion-header"><div class="companion-brand"><span class="brand-mark">${icon("music")}</span><div><span class="wordmark">ZURADIO</span><h1>Web Companion</h1></div></div>${connected ? `<span class="connection-live">${capitalize(mode ?? "listen")}</span>` : ""}</header>
    ${connected ? `<section class="connection-panel connected-strip"><div class="connection-summary"><span class="broadcast-indicator active"></span><div><strong>${escapeHtml(connectionStatus)}</strong><span>Linked directly to the laptop</span></div></div>${renderModeSwitcher(mode ?? "listen")}<button data-action="disconnect" ${disabled()}>Disconnect</button></section>` : renderConnectionModes()}
    ${connected && mode !== "upload" ? `<section class="companion-player">
      <div class="companion-player-heading"><h2>Now playing</h2><span>${mode === "control" ? "Laptop output" : "Live stream"}</span></div>
      ${renderNowPlaying()}
      ${renderSoundVisualizer("companion-visualizer")}
      <div data-audio-mount></div>
      ${renderStreamAudioControls()}
      ${mode === "control" && snapshot ? renderTransport(snapshot) : ""}
    </section>` : ""}
    ${mode === "control" && snapshot ? renderController(snapshot) : ""}
    ${mode === "upload" ? renderUpload() : ""}
    ${connected && mode === "listen" ? `<p class="muted access-note">Listen access is read-only. Player and library controls remain on the laptop.</p>` : ""}
    ${dialogMode ? renderPasswordDialog(dialogMode) : ""}
    ${renamingPlaylistId ? renderRenamePlaylistDialog(renamingPlaylistId) : ""}
  </main>`;
  root.querySelector("[data-audio-mount]")?.append(audio);
  visualizer.mount(root.querySelector<SVGSVGElement>("[data-testid='companion-visualizer']"), bridge);
}

function renderModeSwitcher(mode: RemoteMode): string {
  const modes: Array<[RemoteMode, string, IconName]> = [
    ["listen", "Listen", "volume"],
    ["control", "Control", "library"],
    ["upload", "Upload", "upload"],
  ];
  return `<nav class="mode-switcher" aria-label="Access mode">${modes
    .map(
      ([value, label, iconName]) => `<button data-action="switch-mode" data-mode="${value}" data-testid="switch-${value}" aria-current="${mode === value ? "page" : "false"}" aria-label="${mode === value ? `${label} mode active` : `Switch to ${label.toLocaleLowerCase()} mode`}" ${disabled()}>${icon(iconName)}<span>${label}</span></button>`,
    )
    .join("")}</nav>`;
}

function renderConnectionModes(): string {
  const trustedUntil = bridge.trustedUntil;
  return `<section class="connection-panel access-landing">
    <span class="eyebrow">Laptop link</span>
    <h2>Choose access</h2>
    <p class="muted">${trustedUntil ? "This browser is trusted. Choose a mode to connect without entering the password again." : "The password finds your active Zuradio laptop and opens only the mode you select."}</p>
    ${trustedUntil ? `<div class="trusted-device" data-testid="trusted-device"><span>Trusted until ${escapeHtml(formatTrustedUntil(trustedUntil))}</span><button data-action="forget-device">Forget this browser</button></div>` : ""}
    <div class="connect-modes">
      <button data-action="choose-mode" data-mode="listen" data-testid="connect-listen"><span>${icon("volume")}</span><strong>Listen</strong><small>Hear the live stream</small></button>
      <button data-action="choose-mode" data-mode="control" data-testid="connect-control"><span>${icon("library")}</span><strong>Control</strong><small>Player, queue and playlists</small></button>
      <button data-action="choose-mode" data-mode="upload" data-testid="connect-upload"><span>${icon("upload")}</span><strong>Upload</strong><small>Add music to the laptop</small></button>
    </div>
  </section>`;
}

function renderPasswordDialog(mode: RemoteMode): string {
  return `<div class="password-backdrop" role="presentation">
    <section class="password-dialog" role="dialog" aria-modal="true" aria-labelledby="password-title">
      <span class="eyebrow">${capitalize(mode)} access</span>
      <h2 id="password-title">Connect to Zuradio</h2>
      <p class="muted">Enter the password stored on the laptop.</p>
      ${busy ? `<p class="muted" role="status" data-testid="connection-progress">${escapeHtml(connectionStatus)}</p>` : ""}
      ${errorMessage ? `<p class="notice error" role="alert">${escapeHtml(errorMessage)}</p>` : ""}
      <form data-connect-form data-mode="${mode}">
        <label for="password">Password</label>
        <input id="password" name="password" data-password data-testid="password" type="password" minlength="8" maxlength="256" autocomplete="current-password" required />
        <div class="dialog-actions"><button type="button" data-action="cancel-connect" ${disabled()}>Cancel</button><button class="primary" data-testid="connect" ${disabled()}>${busy ? "Connecting…" : "Connect"}</button></div>
      </form>
    </section>
  </div>`;
}

function renderRenamePlaylistDialog(playlistId: string): string {
  const playlist = playlistById(playlistId);
  if (!playlist) return "";
  return `<div class="password-backdrop" role="presentation">
    <section class="password-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-playlist-title">
      <span class="eyebrow">Playlist library</span>
      <h2 id="rename-playlist-title">Rename playlist</h2>
      <form data-rename-playlist-form data-playlist-id="${escapeAttribute(playlist.id)}">
        <label for="rename-playlist">Name</label>
        <input id="rename-playlist" name="playlistName" data-rename-playlist maxlength="80" required value="${escapeAttribute(playlist.name)}" />
        <div class="dialog-actions"><button type="button" data-action="cancel-rename" ${disabled()}>Cancel</button><button class="primary" ${disabled()}>Save name</button></div>
      </form>
    </section>
  </div>`;
}

function renderUpload(): string {
  return `<section class="upload-panel">
    <div class="upload-heading"><span class="upload-mark">${icon("upload")}</span><div><h2>Add music to this laptop</h2><p class="muted">Files travel directly through the encrypted live bridge. GitHub Pages never stores the music.</p></div></div>
    <div class="upload-picker">
      <label class="button" for="upload-files">Choose files</label>
      <input id="upload-files" data-upload-files type="file" multiple accept="${SUPPORTED_AUDIO_ACCEPT}" />
      <label class="button" for="upload-folder">Choose folder</label>
      <input id="upload-folder" data-upload-folder type="file" multiple webkitdirectory />
    </div>
    <p class="muted" data-testid="upload-selection">${selectedFiles.length ? `${selectedFiles.length} file${selectedFiles.length === 1 ? "" : "s"} selected` : "Choose individual audio files or an entire folder."}</p>
    <button class="primary" data-action="upload" data-testid="upload" ${selectedFiles.length && !busy ? "" : "disabled"}>Upload to Zuradio</button>
    ${uploadProgress ? `<p class="upload-progress" role="status" data-testid="upload-progress">${escapeHtml(uploadProgress)}</p>` : ""}
    ${importedFiles.length ? `<ol class="imported-list">${importedFiles.map((file) => `<li><strong>${escapeHtml(file.title)}</strong><span>${escapeHtml(file.artist)} · ${escapeHtml(file.album)}${file.year ? ` · ${file.year}` : ""}</span></li>`).join("")}</ol>` : ""}
  </section>`;
}

function renderNowPlaying(): string {
  const currentTrack = snapshot?.tracks.find((track) => track.id === snapshot?.player.currentTrackId);
  const title = currentTrack?.title ?? publicState?.track?.title ?? "Nothing playing";
  const artist = currentTrack?.artist ?? publicState?.track?.artist ?? "Waiting for the laptop";
  const album = currentTrack?.album ?? publicState?.track?.album ?? "Zuradio live";
  return `<div class="companion-now-playing"><div class="companion-cover tone-${coverTone(`${artist}-${album}`)}"><span class="cover-grooves" aria-hidden="true"></span><strong>${escapeHtml(coverInitials(album || title))}</strong></div><div class="now-playing"><strong data-testid="companion-title">${escapeHtml(title)}</strong><span>${escapeHtml(artist)}</span><small>${escapeHtml(album)}</small></div></div>`;
}

function renderStreamAudioControls(): string {
  return `<div class="stream-audio-controls" aria-label="Stream audio controls">
    <button data-action="toggle-stream-audio">${icon(audio.paused ? "play" : "pause")}<span>${audio.paused ? "Hear stream" : "Pause stream"}</span></button>
    <button data-action="toggle-stream-mute">${icon(audio.muted ? "volumeOff" : "volume")}<span>${audio.muted ? "Unmute stream" : "Mute stream"}</span></button>
    <label><span>Stream volume</span><input data-stream-volume type="range" min="0" max="100" value="${Math.round(audio.volume * 100)}" /></label>
  </div>`;
}

function renderTransport(state: AppSnapshot): string {
  const track = state.tracks.find((candidate) => candidate.id === state.player.currentTrackId);
  const playing = state.player.status === "playing";
  return `<div class="companion-transport" aria-label="Remote player controls">
    <div class="remote-transport-main"><button class="icon" data-action="previous" aria-label="Previous">${icon("previous")}</button><button class="primary remote-primary" data-action="${playing ? "pause" : "play"}" data-testid="remote-play-pause">${icon(playing ? "pause" : "play")}<span>${playing ? "Pause" : "Play"}</span></button><button class="icon" data-action="next" aria-label="Next">${icon("next")}</button><button class="icon" data-action="stop" aria-label="Stop">${icon("stop")}</button></div>
    <input class="remote-seek" data-seek type="range" min="0" max="${Math.max(track?.durationMs ?? 0, 1)}" value="${Math.min(state.player.positionMs, track?.durationMs ?? 0)}" aria-label="Seek position" ${track ? "" : "disabled"} />
    <div class="remote-options"><button class="${state.player.shuffle ? "active" : ""}" data-action="shuffle" aria-pressed="${state.player.shuffle}">${icon("shuffle")}<span>Shuffle</span></button><button class="${state.player.repeat !== "off" ? "active" : ""}" data-action="repeat" aria-label="Repeat mode: ${state.player.repeat}">${icon("repeat")}<span>Repeat ${state.player.repeat}</span></button><button data-action="mute">${icon(state.player.muted ? "volumeOff" : "volume")}<span>${state.player.muted ? "Unmute" : "Mute"}</span></button><input data-volume type="range" min="0" max="100" value="${state.player.volume}" aria-label="Laptop volume" /></div>
  </div>`;
}

function renderController(state: AppSnapshot): string {
  return `<section class="controller-panel">
    <nav class="nav" aria-label="Controller sections">
      ${(["library", "queue", "playlists"] as ControllerView[])
        .map((item) => `<button data-action="view" data-view="${item}" aria-current="${view === item ? "page" : "false"}">${icon(item === "library" ? "library" : item === "queue" ? "queue" : "playlist")}<span>${capitalize(item)}</span></button>`)
        .join("")}
    </nav>
    <div class="controller-view">${view === "library" ? renderLibrary(state) : view === "queue" ? renderQueue(state) : renderPlaylists(state)}</div>
  </section>`;
}

function renderLibrary(state: AppSnapshot): string {
  const query = search.trim().toLocaleLowerCase();
  const tracks = state.tracks.filter((track) =>
    !query || [track.title, track.artist, track.album].some((value) => value.toLocaleLowerCase().includes(query)),
  );
  const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? state.playlists[0];
  return `<div class="controller-view-header"><div><h2>Library</h2><span>${tracks.length} track${tracks.length === 1 ? "" : "s"}</span></div><label class="toolbar-search">${icon("library")}<input class="search" data-search type="search" value="${escapeAttribute(search)}" placeholder="Search library" aria-label="Search library" /></label></div>
    <div class="track-table-head companion-track-head" aria-hidden="true"><span>#</span><span>Title</span><span>Artist</span><span>Album</span><span>Time</span><span></span></div><ol class="track-list music-track-list">${tracks
      .map(
        (track) => `<li class="track-row">
          <button class="track-cover-button" data-action="play-track" data-track-id="${escapeAttribute(track.id)}" aria-label="Play ${escapeAttribute(track.title)}"><span class="track-cover cover-placeholder tone-${coverTone(`${track.artist}-${track.album}`)}">${escapeHtml(coverInitials(track.album || track.title))}</span><span class="track-play-overlay">${icon("play")}</span></button>
          <div class="track-title"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.artist)}</span></div>
          <div class="track-cell track-artist">${escapeHtml(track.artist)}</div>
          <div class="track-cell track-album">${escapeHtml(track.album)}</div>
          <div class="track-duration">${formatTime(track.durationMs)}</div>
          <div class="track-actions">
            <button class="${state.favorites.includes(track.id) ? "active" : ""}" data-action="favorite" data-track-id="${escapeAttribute(track.id)}" data-enabled="${!state.favorites.includes(track.id)}" aria-label="${state.favorites.includes(track.id) ? "Remove from" : "Add to"} favorites">${icon("heart")}</button>
            <button data-action="queue-add" data-track-id="${escapeAttribute(track.id)}" aria-label="Add ${escapeAttribute(track.title)} to queue">${icon("queue")}</button>
            ${selected ? `<button data-action="playlist-add" data-playlist-id="${escapeAttribute(selected.id)}" data-track-id="${escapeAttribute(track.id)}" aria-label="Add to ${escapeAttribute(selected.name)}">${icon("playlist")}</button>` : ""}
          </div>
        </li>`,
      )
      .join("")}</ol>`;
}

function renderQueue(state: AppSnapshot): string {
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  return `<div class="controller-view-header"><div><h2>Queue</h2><span>${state.player.queue.length} track${state.player.queue.length === 1 ? "" : "s"}</span></div><button data-action="queue-clear" ${state.player.queue.length ? "" : "disabled"}>Clear</button></div>
    <ol class="queue-list">${state.player.queue
      .map((id, index) => {
        const track = byId.get(id);
        const title = track?.title ?? "Unavailable";
        return `<li class="queue-item${index === state.player.queueCursor ? " current" : ""}"><span>${index + 1}</span><span class="track-title"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(track?.artist ?? "")}</span></span><span class="queue-buttons"><button data-action="queue-move" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move ${escapeAttribute(title)} up" ${index === 0 ? "disabled" : ""}>${icon("chevronUp")}</button><button data-action="queue-move" data-from="${index}" data-to="${Math.min(state.player.queue.length - 1, index + 1)}" aria-label="Move ${escapeAttribute(title)} down" ${index === state.player.queue.length - 1 ? "disabled" : ""}>${icon("chevronDown")}</button><button data-action="queue-remove" data-index="${index}" aria-label="Remove ${escapeAttribute(title)} from queue">${icon("close")}</button></span></li>`;
      })
      .join("")}</ol>`;
}

function renderPlaylists(state: AppSnapshot): string {
  const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? state.playlists[0];
  if (selected) selectedPlaylistId = selected.id;
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  const query = playlistSearch.trim().toLocaleLowerCase();
  const availableTracks = state.tracks.filter((track) =>
    !query || [track.title, track.artist, track.album].some((value) => value.toLocaleLowerCase().includes(query)),
  );
  return `<div class="playlist-library" data-testid="playlist-library">
    <div class="playlist-library-header"><div><span class="eyebrow">Saved on laptop</span><h2>Playlist library</h2></div><span class="playlist-total">${state.playlists.length}</span></div>
    <form class="playlist-create" data-playlist-form><label for="new-playlist">Create a playlist</label><div><input id="new-playlist" name="playlistName" maxlength="80" required placeholder="Playlist name" aria-label="New playlist name" /><button class="primary" data-testid="create-playlist">Create</button></div></form>
    ${state.playlists.length ? `<div class="playlist-mobile-layout"><nav class="playlist-shelf" aria-label="Playlist library">${state.playlists
      .map((playlist) => `<button class="playlist-card${playlist.id === selected?.id ? " selected" : ""}" data-action="select-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-current="${playlist.id === selected?.id ? "true" : "false"}"><strong>${escapeHtml(playlist.name)}</strong><span>${playlist.trackIds.length} track${playlist.trackIds.length === 1 ? "" : "s"}</span></button>`)
      .join("")}</nav>
      <section class="playlist-workspace">${selected ? `<div class="playlist-workspace-header"><div><span class="eyebrow">Selected playlist</span><h3>${escapeHtml(selected.name)}</h3></div><div class="row-actions"><button data-action="rename-playlist" data-playlist-id="${escapeAttribute(selected.id)}">Rename</button><button class="danger" data-action="delete-playlist" data-playlist-id="${escapeAttribute(selected.id)}">Delete</button></div></div>
      <button class="add-tracks-button" data-action="toggle-playlist-picker">${playlistPickerOpen ? "Close track picker" : "Add tracks"}</button>
      ${playlistPickerOpen ? `<section class="playlist-track-picker"><label for="playlist-track-search">Find music</label><input id="playlist-track-search" data-playlist-search type="search" value="${escapeAttribute(playlistSearch)}" placeholder="Title, artist or album" />
        <ol>${availableTracks.map((track) => `<li><span><strong>${escapeHtml(track.title)}</strong><small>${escapeHtml(track.artist)} · ${escapeHtml(track.album)}</small></span><button data-action="playlist-add" data-playlist-id="${escapeAttribute(selected.id)}" data-track-id="${escapeAttribute(track.id)}" ${selected.trackIds.includes(track.id) ? "disabled" : ""}>${selected.trackIds.includes(track.id) ? "Added" : "Add"}</button></li>`).join("")}</ol></section>` : ""}
      <div class="saved-selection"><span class="eyebrow">Saved selection</span>${selected.trackIds.length ? `<ol class="playlist-tracks">${selected.trackIds
        .map((id, index) => {
          const title = byId.get(id)?.title ?? "Unavailable";
          const artist = byId.get(id)?.artist ?? "";
          return `<li><span class="playlist-position">${String(index + 1).padStart(2, "0")}</span><span class="track-title"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(artist)}</span></span><span class="playlist-track-actions"><button data-action="playlist-move" data-playlist-id="${escapeAttribute(selected.id)}" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move ${escapeAttribute(title)} up" ${index === 0 ? "disabled" : ""}>↑</button><button data-action="playlist-move" data-playlist-id="${escapeAttribute(selected.id)}" data-from="${index}" data-to="${Math.min(selected.trackIds.length - 1, index + 1)}" aria-label="Move ${escapeAttribute(title)} down" ${index === selected.trackIds.length - 1 ? "disabled" : ""}>↓</button><button data-action="playlist-remove" data-playlist-id="${escapeAttribute(selected.id)}" data-index="${index}" aria-label="Remove ${escapeAttribute(title)} from playlist">×</button></span></li>`;
        })
        .join("")}</ol>` : `<p class="empty">No tracks saved yet. Tap Add tracks to build this playlist.</p>`}</div>` : ""}</section></div>` : `<p class="empty">Create your first playlist above. It will be saved in the laptop library.</p>`}
  </div>`;
}

function playlistById(id: string | undefined): Playlist | undefined {
  return snapshot?.playlists.find((playlist) => playlist.id === id);
}

function coverInitials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : words[0]?.slice(0, 2) ?? "ZU").toLocaleUpperCase();
}

function coverTone(value: string): number {
  return [...value].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 4;
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

function formatTrustedUntil(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
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

window.addEventListener("pagehide", () => {
  visualizer.destroy();
  void bridge.disconnect();
});
