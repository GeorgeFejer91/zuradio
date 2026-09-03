import "./style.css";

import { ZuradioApi } from "./api";
import { AudioEngine } from "./audio-engine";
import { icon, type IconName } from "./icons";
import type {
  Action,
  AppSnapshot,
  BroadcastSession,
  ChatMessage,
  Playlist,
  RemoteUploadResponse,
  Track,
  UploadOperation,
} from "./types";
import { HostBroadcastBridge } from "./vdo";
import { renderSoundVisualizer, SvgSoundVisualizer } from "./visualizer";

type View = "library" | "albums" | "artists" | "playlists" | "favorites" | "history" | "chat" | "broadcast";

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Missing app root");
const root: HTMLDivElement = rootElement;
const autoBroadcast = new URLSearchParams(location.hash.slice(1)).get("autobroadcast") !== "0";

const api = new ZuradioApi();
let snapshot: AppSnapshot | null = null;
let view: View = "library";
let search = "";
let chatDraft = "";
let selectedPlaylistId: string | null = null;
let editingTrackId: string | null = null;
let broadcastSession: BroadcastSession | null = null;
let busy = false;
let message: { text: string; error: boolean } | null = null;
let positionMs = 0;
let messageTimer = 0;
let pendingTasks = 0;
let taskTail: Promise<void> = Promise.resolve();
let checkingBroadcastOwnership = false;
let automaticBroadcastRetryTimer = 0;
let automaticBroadcastRetryCount = 0;
let recoveringBroadcastTransport = false;
let transferActivity: TransferActivity | null = null;
let transferClearTimer = 0;
const BROADCAST_START_ATTEMPTS = 5;
const AUTOMATIC_BROADCAST_RETRY_DELAYS_MS = [5_000, 10_000, 30_000, 60_000] as const;

const audio = new AudioEngine(
  (trackId) => api.mediaUrl(trackId),
  () => void perform({ kind: "next" }),
  (reason) => {
    showMessage(reason, true);
    void perform({ kind: "report_playback", status: "error", positionMs, error: reason }, false);
  },
  (position) => {
    positionMs = position;
    updateProgress();
  },
);
const visualizer = new SvgSoundVisualizer();

const bridge = new HostBroadcastBridge({
  snapshot: () => {
    if (!api.currentSnapshot) throw new Error("Player state is unavailable");
    return api.currentSnapshot;
  },
  broadcast: () => api.broadcastStatus(),
  verify: (payload) => api.verifyRemote(payload),
  action: async (payload) => {
    const result = await api.remoteAction(payload);
    const current = api.currentSnapshot;
    if (current) {
      snapshot = current;
      await audio.sync(current, { forcePosition: remotePayloadChangesTimeline(payload) });
      render();
    }
    return result;
  },
  upload: async (payload) => {
    const operation = uploadOperation(payload);
    const sequence = uploadSequence(payload);
    prepareTransferActivity(operation);
    try {
      const result = await api.remoteUpload(payload);
      updateTransferActivity(operation, result);
      snapshot = api.currentSnapshot;
      if (result.snapshot) render();
      else refreshTransferActivity();
      return result;
    } catch (error) {
      failTransferActivity(operation, messageOf(error), sequence);
      refreshTransferActivity();
      throw error;
    }
  },
  onSessionReplaced: () => {
    void verifyBroadcastOwnership();
  },
  onTransportFailed: () => recoverBroadcastTransport(),
  onError: (reason) => showMessage(reason, true),
});

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target) return;
  const action = target.dataset.action;
  const changesOnlyLocalView =
    action !== undefined && ["nav", "group", "select-playlist", "open-playlist", "edit-track", "close-metadata"].includes(action);
  if (busy && !changesOnlyLocalView) return;
  void handleClick(target);
});

root.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
  if (form.matches("[data-chat-form]")) {
    void postChat(form);
    return;
  }
  if (form.matches("[data-metadata-form]")) {
    void saveMetadata(form);
    return;
  }
  if (!form.matches("[data-playlist-form]")) return;
  const input = form.elements.namedItem("playlistName") as HTMLInputElement;
  const name = input.value.trim();
  if (name) void createPlaylist(name);
});

root.addEventListener("input", (event) => {
  const target = event.target as HTMLInputElement | HTMLTextAreaElement;
  if (target.matches("[data-search]")) {
    search = target.value;
    render();
  } else if (target.matches("[data-chat-input]")) {
    chatDraft = target.value;
  } else if (target.matches("[data-seek]")) {
    positionMs = Number(target.value);
    updateProgress();
  }
});

root.addEventListener("change", (event) => {
  const target = event.target as HTMLInputElement;
  if (target.matches("[data-volume]")) void perform({ kind: "set_volume", volume: Number(target.value) });
  if (target.matches("[data-seek]")) {
    const value = Number(target.value);
    const trackId = snapshot?.player.currentTrackId;
    if (!trackId) return;
    audio.seek(value);
    void perform({ kind: "seek", positionMs: value, trackId });
  }
});

window.setInterval(() => void verifyBroadcastOwnership(), 750);
void initialize();

async function verifyBroadcastOwnership(): Promise<void> {
  const ownedSession = broadcastSession;
  if (!ownedSession || checkingBroadcastOwnership) return;
  checkingBroadcastOwnership = true;
  try {
    const current = await api.broadcastStatus();
    if (
      current &&
      current.sessionId === ownedSession.sessionId &&
      current.epoch === ownedSession.epoch
    ) return;
    await bridge.stop();
    if (broadcastSession === ownedSession) markBroadcastUnavailable(current);
  } catch {
    // A service restart can make one poll fail; the next successful poll decides ownership.
  } finally {
    checkingBroadcastOwnership = false;
  }
}

function markBroadcastUnavailable(replacement: BroadcastSession | null): void {
  broadcastSession = null;
  interruptTransferActivity("Broadcast replaced before the transfer finished");
  if (replacement) {
    showMessage("A newer Zuradio window replaced this remote-access beacon", true);
  } else if (autoBroadcast) {
    showMessage("Remote-access beacon interrupted; restoring it automatically…", true);
    scheduleAutomaticBroadcastRetry(0);
  } else {
    showMessage("Broadcast stopped; remote connections are revoked", false);
  }
  render();
}

function recoverBroadcastTransport(): void {
  if (!autoBroadcast || !broadcastSession || recoveringBroadcastTransport) return;
  recoveringBroadcastTransport = true;
  void task(async () => {
    try {
      broadcastSession = null;
      interruptTransferActivity("Transfer interrupted while the remote-access beacon recovered");
      showMessage("Remote-access network interrupted; restoring the beacon…", true);
      render();
      await bridge.stop();
      await activateBroadcast(true);
      automaticBroadcastRetryCount = 0;
      showMessage("Remote-access beacon restored", false);
    } catch (error) {
      scheduleAutomaticBroadcastRetry();
      throw error;
    } finally {
      recoveringBroadcastTransport = false;
    }
  });
}

async function initialize(): Promise<void> {
  try {
    snapshot = await api.bootstrap();
    broadcastSession = await api.broadcastStatus();
    selectedPlaylistId = snapshot.playlists[0]?.id ?? null;
    await audio.sync(snapshot);
    api.subscribe((next) => {
      const availableTrackCount = (state: AppSnapshot): number =>
        state.tracks.filter((track) => track.available).length;
      const addedTracks = Math.max(
        0,
        availableTrackCount(next) - (snapshot ? availableTrackCount(snapshot) : availableTrackCount(next)),
      );
      snapshot = next;
      void audio.sync(next).catch((error: unknown) => showMessage(messageOf(error), true));
      bridge.publishState(next);
      if (addedTracks > 0) {
        showMessage(
          `${addedTracks} new track${addedTracks === 1 ? "" : "s"} catalogued and added to the library`,
          false,
        );
      }
      render();
    });
    render();
    if (autoBroadcast) {
      await windowReady();
      startAutomaticBroadcast();
    }
  } catch (error) {
    renderFatal(messageOf(error));
  }
}

async function windowReady(): Promise<void> {
  if (document.readyState !== "complete") {
    await new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
  }
  await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
}

async function handleClick(target: HTMLElement): Promise<void> {
  const action = target.dataset.action;
  if (!action) return;
  if (action === "nav") {
    view = target.dataset.view as View;
    render();
    return;
  }
  if (action === "group") {
    view = "library";
    search = target.dataset.query ?? "";
    render();
    return;
  }
  if (action === "scan") {
    await task(async () => {
      snapshot = await api.scan();
      showMessage(`Library scan complete: ${availableTracks(snapshot).length} tracks`, false);
      render();
    });
    return;
  }
  if (action === "select-playlist") {
    selectedPlaylistId = target.dataset.playlistId ?? null;
    render();
    return;
  }
  if (action === "open-playlist") {
    selectedPlaylistId = target.dataset.playlistId ?? null;
    view = "playlists";
    render();
    return;
  }
  if (action === "rename-playlist") {
    const playlist = playlistById(target.dataset.playlistId);
    if (!playlist) return;
    const name = window.prompt("Rename playlist", playlist.name);
    if (name?.trim()) await perform({ kind: "playlist_rename", playlistId: playlist.id, name });
    return;
  }
  if (action === "delete-playlist") {
    const playlist = playlistById(target.dataset.playlistId);
    if (playlist && window.confirm(`Delete “${playlist.name}”?`)) {
      await perform({ kind: "playlist_delete", playlistId: playlist.id });
      selectedPlaylistId = snapshot?.playlists.find((item) => item.id !== playlist.id)?.id ?? null;
    }
    return;
  }
  if (action === "copy") {
    const value = target.dataset.value;
    if (value) {
      await navigator.clipboard.writeText(value);
      showMessage("Invitation copied", false);
    }
    return;
  }
  if (action === "edit-track") {
    editingTrackId = target.dataset.trackId ?? null;
    render();
    return;
  }
  if (action === "close-metadata") {
    editingTrackId = null;
    render();
    return;
  }
  if (action === "start-broadcast") {
    cancelAutomaticBroadcastRetry();
    await task(async () => {
      await activateBroadcast(false);
      automaticBroadcastRetryCount = 0;
      showMessage("Broadcast started", false);
    });
    return;
  }
  if (action === "stop-broadcast") {
    cancelAutomaticBroadcastRetry();
    await task(async () => {
      await bridge.stop();
      await api.stopBroadcast();
      broadcastSession = null;
      interruptTransferActivity("Transfer interrupted because broadcasting stopped");
      showMessage("Broadcast stopped; remote connections are revoked", false);
      render();
    });
    return;
  }
  if (action === "restart-broadcast") {
    cancelAutomaticBroadcastRetry();
    await task(async () => {
      await bridge.stop();
      broadcastSession = null;
      await activateBroadcast(false);
      automaticBroadcastRetryCount = 0;
      showMessage("Secure remote-access beacon restarted", false);
    });
    return;
  }
  if (action === "clear-chat") {
    if (window.confirm("Clear all chat messages from this Zuradio library?")) {
      await perform({ kind: "chat_clear" }, false);
    }
    return;
  }
  if (action === "delete-chat-message") {
    const messageId = target.dataset.messageId;
    if (messageId) await perform({ kind: "chat_delete", messageId }, false);
    return;
  }

  const trackId = target.dataset.trackId;
  const playlistId = target.dataset.playlistId;
  const index = numberData(target.dataset.index);
  const from = numberData(target.dataset.from);
  const to = numberData(target.dataset.to);
  switch (action) {
    case "play-track":
      if (trackId) await perform({ kind: "play_track", trackId });
      break;
    case "favorite":
      if (trackId) await perform({ kind: "favorite_set", trackId, favorite: target.dataset.enabled === "true" });
      break;
    case "queue-add":
      if (trackId) await perform({ kind: "queue_add", trackId });
      break;
    case "queue-remove":
      if (index !== null) await perform({ kind: "queue_remove", index });
      break;
    case "queue-move":
      if (from !== null && to !== null) await perform({ kind: "queue_move", from, to });
      break;
    case "queue-clear":
      await perform({ kind: "queue_clear" });
      break;
    case "playlist-add":
      if (playlistId && trackId) await perform({ kind: "playlist_add", playlistId, trackId });
      break;
    case "playlist-remove":
      if (playlistId && index !== null) await perform({ kind: "playlist_remove", playlistId, index });
      break;
    case "playlist-move":
      if (playlistId && from !== null && to !== null) {
        await perform({ kind: "playlist_move", playlistId, from, to });
      }
      break;
    case "play":
      await perform({ kind: "play" });
      break;
    case "pause":
      await perform({ kind: "pause" });
      break;
    case "stop":
      await perform({ kind: "stop" });
      break;
    case "next":
      await perform({ kind: "next" });
      break;
    case "previous":
      await perform({ kind: "previous" });
      break;
    case "mute":
      if (snapshot) await perform({ kind: "set_muted", muted: !snapshot.player.muted });
      break;
    case "shuffle":
      if (snapshot) await perform({ kind: "set_shuffle", enabled: !snapshot.player.shuffle });
      break;
    case "repeat":
      if (snapshot) {
        const modes = ["off", "all", "one"] as const;
        const current = modes.indexOf(snapshot.player.repeat);
        await perform({ kind: "set_repeat", mode: modes[(current + 1) % modes.length] ?? "off" });
      }
      break;
  }
}

async function activateBroadcast(automatic: boolean): Promise<void> {
  if (automatic) {
    void audio.unlock().catch(() => undefined);
  } else {
    await audio.unlock();
  }
  if (automatic && broadcastSession) {
    await bridge.stop();
    broadcastSession = null;
  }
  let lastError: unknown = new Error("Broadcast setup failed");
  for (let attempt = 0; attempt < BROADCAST_START_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await wait(retryDelay(attempt - 1));
    let session: BroadcastSession | null = null;
    try {
      session = await api.startBroadcast();
      await bridge.start(session, audio.broadcastStream);
      broadcastSession = session;
      render();
      return;
    } catch (error) {
      lastError = error;
      await bridge.stop().catch(() => undefined);
      if (session) await stopBroadcastIfOwned(session);
      broadcastSession = null;
    }
  }
  throw lastError;
}

function startAutomaticBroadcast(): void {
  void task(async () => {
    try {
      await activateBroadcast(true);
      automaticBroadcastRetryCount = 0;
      showMessage("Broadcast started automatically", false);
    } catch (error) {
      scheduleAutomaticBroadcastRetry();
      throw error;
    }
  });
}

function scheduleAutomaticBroadcastRetry(delayOverrideMs?: number): void {
  if (!autoBroadcast || automaticBroadcastRetryTimer || broadcastSession) return;
  const index = Math.min(automaticBroadcastRetryCount, AUTOMATIC_BROADCAST_RETRY_DELAYS_MS.length - 1);
  const delayMs = delayOverrideMs ?? AUTOMATIC_BROADCAST_RETRY_DELAYS_MS[index] ?? 60_000;
  automaticBroadcastRetryCount += 1;
  automaticBroadcastRetryTimer = window.setTimeout(() => {
    automaticBroadcastRetryTimer = 0;
    startAutomaticBroadcast();
  }, delayMs);
}

function cancelAutomaticBroadcastRetry(): void {
  if (automaticBroadcastRetryTimer) window.clearTimeout(automaticBroadcastRetryTimer);
  automaticBroadcastRetryTimer = 0;
}

async function stopBroadcastIfOwned(session: BroadcastSession): Promise<void> {
  try {
    const current = await api.broadcastStatus();
    if (current?.sessionId === session.sessionId && current.epoch === session.epoch) {
      await api.stopBroadcast();
    }
  } catch {
    // The retry rotates the session; a failed cleanup must not hide the setup error.
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function retryDelay(attempt: number): number {
  return 500 * (2 ** (attempt + 1) - 1);
}

async function saveMetadata(form: HTMLFormElement): Promise<void> {
  const track = snapshot?.tracks.find((candidate) => candidate.id === editingTrackId);
  if (!track) return;
  const data = new FormData(form);
  const optionalNumber = (name: string): number | null => {
    const value = String(data.get(name) ?? "").trim();
    return value ? Number(value) : null;
  };
  await perform({
    kind: "edit_track_metadata",
    trackId: track.id,
    title: String(data.get("title") ?? ""),
    artist: String(data.get("artist") ?? ""),
    album: String(data.get("album") ?? ""),
    albumArtist: String(data.get("albumArtist") ?? ""),
    trackNumber: optionalNumber("trackNumber"),
    discNumber: optionalNumber("discNumber"),
    year: optionalNumber("year"),
  });
  editingTrackId = null;
  render();
}

async function postChat(form: HTMLFormElement): Promise<void> {
  const input = form.elements.namedItem("message") as HTMLTextAreaElement;
  const text = input.value.trim();
  if (!text) return;
  await perform({ kind: "chat_post", text }, false);
  chatDraft = "";
  render();
}

async function perform(action: Action, unlock = true): Promise<void> {
  await task(async () => {
    if (unlock && (action.kind === "play" || action.kind === "play_track")) await audio.unlock();
    try {
      await api.action(action);
    } catch (error) {
      if (action.kind === "seek") {
        audio.cancelLocalSeek();
        const current = api.currentSnapshot;
        if (current) {
          snapshot = current;
          await audio.sync(current, { forcePosition: true });
        }
      }
      throw error;
    }
    snapshot = api.currentSnapshot;
    if (snapshot) {
      await audio.sync(snapshot, { forcePosition: actionChangesTimeline(action) });
      bridge.publishState(snapshot);
    }
    render();
  });
}

function actionChangesTimeline(action: Action): boolean {
  return ["stop", "play_track", "seek", "next", "previous"].includes(action.kind);
}

function remotePayloadChangesTimeline(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false;
  const request = (payload as { request?: unknown }).request;
  if (!request || typeof request !== "object") return false;
  const action = (request as { action?: unknown }).action;
  if (!action || typeof action !== "object") return false;
  const kind = (action as { kind?: unknown }).kind;
  return typeof kind === "string" && ["stop", "play_track", "seek", "next", "previous"].includes(kind);
}

async function createPlaylist(name: string): Promise<void> {
  const existingIds = new Set(snapshot?.playlists.map((playlist) => playlist.id) ?? []);
  await perform({ kind: "playlist_create", name });
  const created = snapshot?.playlists.find((playlist) => !existingIds.has(playlist.id));
  if (created) {
    selectedPlaylistId = created.id;
    render();
  }
}

async function task(operation: () => Promise<void>): Promise<void> {
  pendingTasks += 1;
  busy = true;
  render();
  const running = taskTail.then(operation);
  taskTail = running.catch(() => undefined);
  try {
    await running;
  } catch (error) {
    showMessage(messageOf(error), true);
  } finally {
    pendingTasks -= 1;
    busy = pendingTasks > 0;
    render();
  }
}

function render(): void {
  if (!snapshot) {
    root.innerHTML = `<main class="content"><p class="muted">Opening Zuradio…</p></main>`;
    return;
  }
  const activeChatInput = document.activeElement instanceof HTMLTextAreaElement
    && document.activeElement.matches("[data-chat-input]")
    ? document.activeElement
    : null;
  const chatSelection = activeChatInput
    ? [activeChatInput.selectionStart, activeChatInput.selectionEnd] as const
    : null;
  root.innerHTML = `
    <div class="shell view-${view}" aria-busy="${busy}">
      ${renderSidebar(snapshot)}
      <main class="main${transferActivity ? " has-transfer" : ""}">
        <div class="toolbar">
          <label class="toolbar-search">${icon("library")}<input class="search" data-search data-testid="search" type="search" value="${escapeAttribute(search)}" placeholder="Search all file and Shazam metadata" aria-label="Search library" /></label>
          <span class="toolbar-spacer"></span>
          <button class="scan-button" data-action="scan" data-testid="scan-library" ${disabled()}>${icon("scan")}<span>Scan library</span></button>
        </div>
        ${renderTransferActivity()}
        <div class="content">${renderContent(snapshot)}</div>
      </main>
      ${renderQueue(snapshot)}
    </div>
    ${renderPlayer(snapshot)}
    ${editingTrackId ? renderMetadataEditor(snapshot) : ""}
    <div class="status-line${message?.error ? " error" : ""}" role="status" aria-live="polite" ${message ? "" : "hidden"}>${escapeHtml(message?.text ?? "")}</div>
  `;
  visualizer.mount(root.querySelector<SVGSVGElement>("[data-testid='host-visualizer']"), audio);
  updateProgress();
  scrollChatToLatest();
  if (activeChatInput) {
    const input = root.querySelector<HTMLTextAreaElement>("[data-chat-input]");
    input?.focus();
    if (input && chatSelection) input.setSelectionRange(chatSelection[0], chatSelection[1]);
  }
}

function renderSidebar(state: AppSnapshot): string {
  const tracks = availableTracks(state);
  const items: Array<[View, string, number | string, IconName]> = [
    ["library", "Library", tracks.length, "library"],
    ["albums", "Albums", unique(tracks.map((track) => track.album)).length, "album"],
    ["artists", "Artists", unique(tracks.map((track) => track.artist)).length, "artist"],
    ["playlists", "Playlists", state.playlists.length, "playlist"],
    ["favorites", "Favorites", state.favorites.length, "heart"],
    ["history", "History", state.history.length, "history"],
    ["chat", "Chat", chatMessages(state).length, "chat"],
    ["broadcast", "Broadcast", broadcastSession ? "On" : "Off", "broadcast"],
  ];
  return `<aside class="sidebar">
    <div class="brand"><span class="brand-mark">${icon("music")}</span><div><h1>Zuradio</h1><p>Music on this laptop</p></div></div>
    <nav class="nav" aria-label="Music library">
      ${items
        .map(
          ([id, label, count, iconName]) => `<button data-action="nav" data-view="${id}" aria-label="${label}${id === "broadcast" ? ` ${count}` : ""}" aria-current="${view === id ? "page" : "false"}">
            ${icon(iconName)}<span class="nav-label">${label}</span><span class="nav-count">${count}</span>
          </button>`,
        )
        .join("")}
    </nav>
    <section class="sidebar-playlists" aria-label="Saved playlists">
      <div class="sidebar-section-title"><span>Saved playlists</span><span>${state.playlists.length}</span></div>
      ${state.playlists.length ? state.playlists.slice(0, 7).map((playlist) => `<button data-action="open-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-label="Open ${escapeAttribute(playlist.name)}"><span class="playlist-glyph tone-${coverTone(playlist.name)}">${escapeHtml(coverInitials(playlist.name))}</span><span>${escapeHtml(playlist.name)}</span></button>`).join("") : `<p>No playlists yet</p>`}
    </section>
    <div class="sidebar-status"><span class="broadcast-indicator${broadcastSession ? " active" : ""}"></span><span>${broadcastSession ? "Remote access ready" : autoBroadcast ? "Starting remote access" : "Broadcast offline"}</span></div>
  </aside>`;
}

function renderContent(state: AppSnapshot): string {
  switch (view) {
    case "library":
      return renderTrackSection("Library", filteredTracks(state), state);
    case "favorites":
      return renderTrackSection(
        "Favorites",
        filteredTracks(state).filter((track) => state.favorites.includes(track.id)),
        state,
      );
    case "albums":
      return renderGroups("Albums", groupTracks(availableTracks(state), (track) => track.album));
    case "artists":
      return renderGroups("Artists", groupTracks(availableTracks(state), (track) => track.artist));
    case "playlists":
      return renderPlaylists(state);
    case "history":
      return renderHistory(state);
    case "chat":
      return renderChat(state);
    case "broadcast":
      return renderBroadcast();
  }
}

function renderTrackSection(title: string, tracks: Track[], state: AppSnapshot): string {
  return `<div class="section-header library-header"><div><h2>${title}</h2><p class="muted">${tracks.length} track${tracks.length === 1 ? "" : "s"} in this collection</p></div></div>
    ${tracks.length ? `<div class="track-table-head" aria-hidden="true"><span>#</span><span>Title</span><span>Artist</span><span>Album</span><span>Time</span><span></span></div><ol class="track-list music-track-list">${tracks.map((track) => renderTrack(track, state)).join("")}</ol>` : renderEmpty("No matching tracks")}`;
}

function renderTrack(track: Track, state: AppSnapshot): string {
  const favorite = state.favorites.includes(track.id);
  const playlist = selectedPlaylistId ? state.playlists.find((item) => item.id === selectedPlaylistId) : state.playlists[0];
  return `<li class="track-row" data-track-row="${escapeAttribute(track.id)}">
    <button class="track-cover-button" data-action="play-track" data-track-id="${escapeAttribute(track.id)}" aria-label="Play ${escapeAttribute(track.title)}" title="Play" ${disabled()}>${renderCover(track, "track-cover")}<span class="track-play-overlay">${icon("play")}</span></button>
    <div class="track-title"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.format.toUpperCase())}${track.year ? ` · ${track.year}` : ""}</span>${renderRecognitionLabel(track)}</div>
    <div class="track-cell track-artist">${escapeHtml(track.artist)}</div>
    <div class="track-cell track-album">${escapeHtml(track.album)}</div>
    <div class="track-duration">${formatTime(track.durationMs)}</div>
    <div class="track-actions">
      <button class="${favorite ? "active" : ""}" data-action="favorite" data-track-id="${escapeAttribute(track.id)}" data-enabled="${!favorite}" aria-label="${favorite ? "Remove from" : "Add to"} favorites" title="Favorite" ${disabled()}>${icon("heart")}</button>
      <button data-action="queue-add" data-track-id="${escapeAttribute(track.id)}" aria-label="Add ${escapeAttribute(track.title)} to queue" title="Add to queue" ${disabled()}>${icon("queue")}</button>
      ${playlist ? `<button data-action="playlist-add" data-playlist-id="${escapeAttribute(playlist.id)}" data-track-id="${escapeAttribute(track.id)}" aria-label="Add to ${escapeAttribute(playlist.name)}" title="Add to ${escapeAttribute(playlist.name)}" ${disabled()}>${icon("playlist")}</button>` : ""}
      <button data-action="edit-track" data-track-id="${escapeAttribute(track.id)}" aria-label="Edit metadata for ${escapeAttribute(track.title)}" title="Edit metadata">${icon("edit")}</button>
    </div>
  </li>`;
}

function renderRecognitionLabel(track: Track): string {
  const text = {
    pending: "Shazam metadata · Identifying…",
    recognized: `Shazam metadata · ${track.recognition.label ?? "Recognized"}${track.recognition.genre ? ` · ${track.recognition.genre}` : ""}`,
    no_match: "Shazam metadata · No match",
    unavailable: "Shazam metadata · Recognition helper unavailable",
    error: "Shazam metadata · Retry on next scan",
  }[track.recognition.status];
  return `<span class="recognition-label status-${track.recognition.status}" data-testid="recognition-${escapeAttribute(track.id)}">${escapeHtml(text)}</span>`;
}

function renderMetadataEditor(state: AppSnapshot): string {
  const track = state.tracks.find((candidate) => candidate.id === editingTrackId);
  if (!track) return "";
  return `<div class="metadata-backdrop">
    <section class="metadata-editor" role="dialog" aria-modal="true" aria-labelledby="metadata-title" data-metadata-dialog>
      <div class="section-header"><div><h2 id="metadata-title">Edit track details</h2><p class="muted">Overrides stay in Zuradio and survive future library scans.</p></div><button type="button" data-action="close-metadata" aria-label="Close">×</button></div>
      <form data-metadata-form>
        <label>Title<input name="title" required maxlength="160" value="${escapeAttribute(track.title)}" /></label>
        <label>Artist<input name="artist" required maxlength="160" value="${escapeAttribute(track.artist)}" /></label>
        <label>Album<input name="album" required maxlength="160" value="${escapeAttribute(track.album)}" /></label>
        <label>Album artist<input name="albumArtist" required maxlength="160" value="${escapeAttribute(track.albumArtist)}" /></label>
        <div class="metadata-numbers">
          <label>Track<input name="trackNumber" type="number" min="1" max="9999" value="${track.trackNumber ?? ""}" /></label>
          <label>Disc<input name="discNumber" type="number" min="1" max="999" value="${track.discNumber ?? ""}" /></label>
          <label>Year<input name="year" type="number" min="1000" max="9999" value="${track.year ?? ""}" /></label>
        </div>
        <div class="metadata-actions"><button type="button" data-action="close-metadata">Cancel</button><button class="primary" data-testid="save-metadata" ${disabled()}>Save changes</button></div>
      </form>
    </section>
  </div>`;
}

function renderGroups(title: string, groups: Map<string, Track[]>): string {
  const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  return `<div class="section-header library-header"><div><h2>${title}</h2><p class="muted">${ordered.length} ${title.toLocaleLowerCase()}</p></div></div>
    ${ordered.length ? `<ul class="group-list">${ordered
      .map(
        ([name, tracks]) => `<li class="group-item"><button data-action="group" data-query="${escapeAttribute(name)}" aria-label="${escapeAttribute(name)}"><span class="group-cover">${tracks[0] ? renderCover(tracks[0], "group-cover-art") : ""}</span><span class="group-copy"><strong>${escapeHtml(name)}</strong><span>${tracks.length} track${tracks.length === 1 ? "" : "s"}</span></span></button></li>`,
      )
      .join("")}</ul>` : renderEmpty(`No ${title.toLowerCase()} yet`)}`;
}

function renderPlaylists(state: AppSnapshot): string {
  const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? state.playlists[0];
  if (selected && selected.id !== selectedPlaylistId) selectedPlaylistId = selected.id;
  return `<div class="section-header library-header"><div><h2>Playlists</h2><p class="muted">Saved on this laptop · ${state.playlists.length} total</p></div></div>
    <form class="inline-form" data-playlist-form>
      <input name="playlistName" data-testid="playlist-name" maxlength="80" required placeholder="New playlist name" aria-label="New playlist name" />
      <button class="primary" data-testid="create-playlist" ${disabled()}>Create</button>
    </form>
    <div class="playlist-layout">
      <ul class="playlist-list">
        ${state.playlists
          .map(
            (playlist) => `<li>
              <button class="select-playlist${selected?.id === playlist.id ? " selected" : ""}" data-action="select-playlist" data-playlist-id="${escapeAttribute(playlist.id)}">${escapeHtml(playlist.name)} <span class="muted">${playlist.trackIds.length}</span></button>
              <span class="row-actions">
                <button data-action="rename-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-label="Rename ${escapeAttribute(playlist.name)}" ${disabled()}>${icon("edit")}</button>
                <button class="danger" data-action="delete-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-label="Delete ${escapeAttribute(playlist.name)}" ${disabled()}>${icon("close")}</button>
              </span>
            </li>`,
          )
          .join("")}
      </ul>
      <section>${selected ? renderPlaylistTracks(selected, state) : renderEmpty("Create a playlist to collect tracks")}</section>
    </div>`;
}

function renderPlaylistTracks(playlist: Playlist, state: AppSnapshot): string {
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  return `<h3>${escapeHtml(playlist.name)}</h3>
    ${playlist.trackIds.length ? `<ol class="track-list">${playlist.trackIds
      .map((id, index) => {
        const track = byId.get(id);
        return `<li class="queue-item">
          <span class="queue-index">${index + 1}</span>
          <span class="track-title"><strong>${escapeHtml(track?.title ?? "Unavailable track")}</strong><span>${escapeHtml(track?.artist ?? "Not currently mounted")}</span></span>
          <span class="queue-buttons">
            <button data-action="playlist-move" data-playlist-id="${escapeAttribute(playlist.id)}" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move up" ${busy || index === 0 ? "disabled" : ""}>${icon("chevronUp")}</button>
            <button data-action="playlist-move" data-playlist-id="${escapeAttribute(playlist.id)}" data-from="${index}" data-to="${Math.min(playlist.trackIds.length - 1, index + 1)}" aria-label="Move down" ${busy || index === playlist.trackIds.length - 1 ? "disabled" : ""}>${icon("chevronDown")}</button>
            <button data-action="playlist-remove" data-playlist-id="${escapeAttribute(playlist.id)}" data-index="${index}" aria-label="Remove from playlist" ${disabled()}>${icon("close")}</button>
          </span>
        </li>`;
      })
      .join("")}</ol>` : renderEmpty("This playlist is empty. Select it, then add tracks from Library.")}`;
}

function renderHistory(state: AppSnapshot): string {
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  const tracks = state.history
    .map((entry) => byId.get(entry.trackId))
    .filter((track): track is Track => Boolean(track?.available));
  return renderTrackSection("Recently played", tracks, state);
}

function renderChat(state: AppSnapshot): string {
  const messages = chatMessages(state);
  return `<section class="chat-panel" data-testid="host-chat">
    <div class="section-header library-header chat-header"><div><h2>Chat</h2><p class="muted">Messages shared with authenticated remote Control browsers · latest 20 retained</p></div>${messages.length ? `<button class="danger" data-action="clear-chat" data-testid="clear-chat" ${disabled()}>Clear chat</button>` : ""}</div>
    <div class="chat-log" data-chat-log role="log" aria-live="polite" aria-relevant="additions text">
      ${messages.length ? messages.map((entry) => renderChatMessage(entry, "local")).join("") : `<div class="empty">No messages yet. Open Control mode in the Web Companion to chat with this computer.</div>`}
    </div>
    <form class="chat-compose" data-chat-form>
      <label for="host-chat-message">Message</label>
      <div><textarea id="host-chat-message" name="message" data-chat-input data-testid="host-chat-input" rows="2" maxlength="300" required placeholder="Write a message to the connected remote browser">${escapeHtml(chatDraft)}</textarea><button class="primary" data-testid="host-chat-send" ${disabled()}>Send</button></div>
      <p>Chat carries text only. It cannot run commands or transfer files.</p>
    </form>
  </section>`;
}

function renderChatMessage(entry: ChatMessage, perspective: "local" | "remote"): string {
  const own = entry.sender === perspective;
  const sender = entry.sender === "local" ? "This computer" : "Remote browser";
  return `<article class="chat-message${own ? " is-own" : ""}" data-testid="chat-message" data-sender="${entry.sender}">
    <div><strong>${sender}</strong><span><time datetime="${new Date(entry.sentAtMs).toISOString()}">${escapeHtml(formatChatTime(entry.sentAtMs))}</time><button data-action="delete-chat-message" data-message-id="${escapeAttribute(entry.id)}" aria-label="Delete message" title="Delete message" ${disabled()}>${icon("close")}</button></span></div>
    <p>${escapeHtml(entry.text)}</p>
  </article>`;
}

function renderBroadcast(): string {
  if (!broadcastSession) {
    return `<section class="broadcast-panel">
      <h2>Remote access</h2>
      <div class="broadcast-status"><strong>${autoBroadcast ? "Starting…" : "Off"}</strong><p class="muted">${autoBroadcast ? "Zuradio is restoring its password-protected discovery beacon." : "No remote peer can hear or control this laptop."}</p></div>
      <p>${autoBroadcast ? "The beacon stays available whenever this app is running. It does not start music; playback remains under the player controls." : "Starting a broadcast makes this laptop discoverable from the Zuradio Web Companion after a listener enters the shared password. Music always stays on this laptop."}</p>
      ${autoBroadcast ? "" : `<button class="primary" data-action="start-broadcast" data-testid="start-broadcast" ${disabled()}>Start broadcast</button>`}
    </section>`;
  }
  return `<section class="broadcast-panel">
    <h2>Remote access</h2>
    <div class="broadcast-status live"><strong>Discoverable</strong><p class="muted">The password-protected beacon is active. Music plays only when a player command starts it.</p></div>
    <p class="muted">Laptop player controls take priority whenever a local and external command arrive together.</p>
    <button data-action="restart-broadcast" data-testid="restart-broadcast" ${disabled()}>Restart secure beacon</button>
    ${autoBroadcast ? "" : `<button class="danger" data-action="stop-broadcast" data-testid="stop-broadcast" ${disabled()}>Stop broadcast</button>`}
    <div class="access-modes" data-testid="access-modes">
      <div><strong>Listen</strong><span>Live audio and current track</span></div>
      <div><strong>Control</strong><span>Player, chat, queue, library and playlists</span></div>
      <div><strong>Upload</strong><span>Send folders or music files to this laptop</span></div>
    </div>
  </section>`;
}

function renderQueue(state: AppSnapshot): string {
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  return `<aside class="right-panel"><div class="right-header"><div><h2>Queue</h2><span>${state.player.queue.length} track${state.player.queue.length === 1 ? "" : "s"}</span></div><button data-action="queue-clear" ${busy || !state.player.queue.length ? "disabled" : ""}>Clear</button></div>
    ${state.player.queue.length ? `<ol class="queue-list">${state.player.queue
      .map((id, index) => {
        const track = byId.get(id);
        return `<li class="queue-item${index === state.player.queueCursor ? " current" : ""}">
          <span class="queue-index">${index + 1}</span>
          <span class="track-title"><strong>${escapeHtml(track?.title ?? "Unavailable")}</strong><span>${escapeHtml(track?.artist ?? "")}</span></span>
          <span class="queue-buttons">
            <button data-action="queue-move" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move up" ${busy || index === 0 ? "disabled" : ""}>${icon("chevronUp")}</button>
            <button data-action="queue-move" data-from="${index}" data-to="${Math.min(state.player.queue.length - 1, index + 1)}" aria-label="Move down" ${busy || index === state.player.queue.length - 1 ? "disabled" : ""}>${icon("chevronDown")}</button>
            <button data-action="queue-remove" data-index="${index}" aria-label="Remove from queue" ${disabled()}>${icon("close")}</button>
          </span>
        </li>`;
      })
      .join("")}</ol>` : renderEmpty("Queue is empty")}
  </aside>`;
}

function renderPlayer(state: AppSnapshot): string {
  const track = state.tracks.find((candidate) => candidate.id === state.player.currentTrackId);
  const duration = track?.durationMs ?? 0;
  const playing = state.player.status === "playing";
  return `<footer class="player" aria-label="Player controls">
    <div class="now-playing has-artwork">
      ${track ? renderCover(track, "album-art") : `<span class="album-art cover-placeholder tone-0">ZU</span>`}
      <div class="now-copy"><strong data-testid="now-title">${escapeHtml(track?.title ?? "Nothing playing")}</strong><span>${escapeHtml(track?.artist ?? "Choose a track from the library")}</span></div>
    </div>
    <div class="transport">
      ${renderSoundVisualizer("host-visualizer")}
      <div class="transport-buttons">
        <button class="icon" data-action="previous" aria-label="Previous track" ${disabled()}>${icon("previous")}</button>
        <button class="icon player-primary" data-action="${playing ? "pause" : "play"}" data-testid="play-pause" aria-label="${playing ? "Pause" : "Play"}" ${disabled()}>${icon(playing ? "pause" : "play")}</button>
        <button class="icon" data-action="next" aria-label="Next track" ${disabled()}>${icon("next")}</button>
        <button class="icon" data-action="stop" aria-label="Stop" ${disabled()}>${icon("stop")}</button>
      </div>
      <div class="progress-row">
        <span class="time" data-current-time>${formatTime(positionMs)}</span>
        <input data-seek data-testid="seek" type="range" min="0" max="${Math.max(duration, 1)}" step="250" value="${Math.min(positionMs, Math.max(duration, 1))}" aria-label="Seek position" ${track ? "" : "disabled"} />
        <span class="time">${formatTime(duration)}</span>
      </div>
    </div>
    <div class="output-controls">
      <button class="shuffle-button${state.player.shuffle ? " active" : ""}" data-action="shuffle" aria-pressed="${state.player.shuffle}" aria-label="Shuffle" ${disabled()}>${icon("shuffle")}</button>
      <button class="repeat-button${state.player.repeat !== "off" ? " active" : ""}" data-action="repeat" aria-label="Repeat mode: ${state.player.repeat}" ${disabled()}>${icon("repeat")}${state.player.repeat === "one" ? `<span class="repeat-one">1</span>` : ""}</button>
      <button class="icon" data-action="mute" aria-label="${state.player.muted ? "Unmute" : "Mute"}" ${disabled()}>${icon(state.player.muted ? "volumeOff" : "volume")}</button>
      <input data-volume data-testid="volume" type="range" min="0" max="100" value="${state.player.volume}" aria-label="Volume" />
    </div>
  </footer>`;
}

function renderCover(track: Track, className: string): string {
  if (track.hasArtwork) {
    return `<img class="${className} cover-art" src="${escapeAttribute(api.artworkUrl(track.id))}" alt="" loading="lazy" />`;
  }
  return `<span class="${className} cover-placeholder tone-${coverTone(`${track.artist}-${track.album}`)}">${escapeHtml(coverInitials(track.album || track.title))}</span>`;
}

function coverInitials(value: string): string {
  const words = value.trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : words[0]?.slice(0, 2) ?? "ZU").toLocaleUpperCase();
}

function coverTone(value: string): number {
  return [...value].reduce((sum, character) => sum + (character.codePointAt(0) ?? 0), 0) % 4;
}

function filteredTracks(state: AppSnapshot): Track[] {
  const query = search.trim().toLocaleLowerCase();
  const tracks = availableTracks(state);
  if (!query) return tracks;
  return tracks.filter((track) =>
    [
      track.title,
      track.artist,
      track.album,
      track.albumArtist,
      track.format,
      track.year?.toString() ?? "",
      track.recognition.label ?? "",
      track.recognition.title ?? "",
      track.recognition.artist ?? "",
      track.recognition.album ?? "",
      track.recognition.genre ?? "",
    ].some((value) =>
      value.toLocaleLowerCase().includes(query),
    ),
  );
}

function availableTracks(state: AppSnapshot): Track[] {
  return state.tracks.filter((track) => track.available);
}

function chatMessages(state: AppSnapshot): ChatMessage[] {
  return state.chatMessages ?? [];
}

function scrollChatToLatest(): void {
  if (view !== "chat") return;
  const log = root.querySelector<HTMLElement>("[data-chat-log]");
  if (log) log.scrollTop = log.scrollHeight;
}

type TransferPhase = "receiving" | "cataloguing" | "finalizing" | "complete" | "interrupted";

interface TransferFileActivity {
  id: string;
  path: string;
  size: number;
  received: number;
  catalogued: boolean;
  title: string | null;
}

interface TransferActivity {
  id: string;
  phase: TransferPhase;
  files: TransferFileActivity[];
  activeFileId: string | null;
  detail: string | null;
  failureSequence: number | null;
}

function uploadSequence(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const sequence = (payload as { sequence?: unknown }).sequence;
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0 ? sequence : null;
}

function uploadOperation(payload: unknown): UploadOperation | null {
  if (!payload || typeof payload !== "object") return null;
  const operation = (payload as { operation?: unknown }).operation;
  if (!operation || typeof operation !== "object") return null;
  const candidate = operation as Record<string, unknown>;
  if (typeof candidate.transferId !== "string" || candidate.transferId.length > 80) return null;
  switch (candidate.kind) {
    case "begin":
      if (
        !Array.isArray(candidate.files) ||
        candidate.files.length < 1 ||
        candidate.files.length > 512 ||
        !candidate.files.every(
          (file) =>
            file &&
            typeof file === "object" &&
            typeof (file as Record<string, unknown>).fileId === "string" &&
            typeof (file as Record<string, unknown>).relativePath === "string" &&
            typeof (file as Record<string, unknown>).size === "number",
        )
      ) return null;
      break;
    case "chunk":
      if (typeof candidate.fileId !== "string" || typeof candidate.offset !== "number") return null;
      break;
    case "finish_file":
      if (typeof candidate.fileId !== "string" || typeof candidate.sha256 !== "string") return null;
      break;
    case "commit":
    case "abort":
      break;
    default:
      return null;
  }
  return operation as UploadOperation;
}

function prepareTransferActivity(operation: UploadOperation | null): void {
  if (!operation) return;
  if (operation.kind === "begin") {
    window.clearTimeout(transferClearTimer);
    transferClearTimer = 0;
    transferActivity = {
      id: operation.transferId,
      phase: "receiving",
      files: operation.files.map((file) => ({
        id: file.fileId,
        path: file.relativePath,
        size: file.size,
        received: 0,
        catalogued: false,
        title: null,
      })),
      activeFileId: operation.files[0]?.fileId ?? null,
      detail: null,
      failureSequence: null,
    };
    render();
    return;
  }
  if (!transferActivity || transferActivity.id !== operation.transferId) return;
  if (operation.kind === "chunk") {
    transferActivity.phase = "receiving";
    transferActivity.activeFileId = operation.fileId;
  } else if (operation.kind === "finish_file") {
    transferActivity.phase = "cataloguing";
    transferActivity.activeFileId = operation.fileId;
    refreshTransferActivity();
  } else if (operation.kind === "commit") {
    transferActivity.phase = "finalizing";
    transferActivity.activeFileId = null;
    refreshTransferActivity();
  }
}

function updateTransferActivity(operation: UploadOperation | null, response: RemoteUploadResponse): void {
  if (!operation || !transferActivity || transferActivity.id !== operation.transferId) return;
  if (operation.kind === "chunk") {
    const file = transferActivity.files.find((candidate) => candidate.id === operation.fileId);
    if (file && typeof response.outcome.received === "number") file.received = response.outcome.received;
    return;
  }
  if (operation.kind === "finish_file") {
    const file = transferActivity.files.find((candidate) => candidate.id === operation.fileId);
    if (file) {
      file.received = file.size;
      file.catalogued = true;
      file.title = response.outcome.imported[0]?.title ?? null;
    }
    transferActivity.phase = "receiving";
    transferActivity.activeFileId =
      transferActivity.files.find((candidate) => !candidate.catalogued)?.id ?? null;
    return;
  }
  if (operation.kind === "commit") {
    transferActivity.phase = "complete";
    transferActivity.activeFileId = null;
    transferActivity.detail = `${response.outcome.imported.length} new track${response.outcome.imported.length === 1 ? " is" : "s are"} ready in Zuradio Library`;
    transferClearTimer = window.setTimeout(() => {
      transferActivity = null;
      transferClearTimer = 0;
      refreshTransferActivity();
    }, 15_000);
  } else if (operation.kind === "abort") {
    interruptTransferActivity("The remote browser cancelled the remaining transfer");
  }
}

function failTransferActivity(operation: UploadOperation | null, reason: string, sequence: number | null): void {
  if (!operation || !transferActivity || transferActivity.id !== operation.transferId) return;
  interruptTransferActivity(reason, sequence);
}

function interruptTransferActivity(reason: string, sequence: number | null = null): void {
  if (!transferActivity || transferActivity.phase === "complete") return;
  if (transferActivity.phase === "interrupted") {
    if (
      sequence !== null &&
      (transferActivity.failureSequence === null || sequence < transferActivity.failureSequence)
    ) {
      transferActivity.failureSequence = sequence;
      transferActivity.detail = reason;
    }
    return;
  }
  transferActivity.phase = "interrupted";
  transferActivity.activeFileId = null;
  transferActivity.detail = reason;
  transferActivity.failureSequence = sequence;
}

function refreshTransferActivity(): void {
  const current = root.querySelector<HTMLElement>("[data-testid='local-transfer-status']");
  if (!current) {
    render();
    return;
  }
  current.outerHTML = renderTransferActivity();
}

function renderTransferActivity(): string {
  if (!transferActivity) {
    return `<section data-testid="local-transfer-status" hidden></section>`;
  }
  const totalBytes = transferActivity.files.reduce((total, file) => total + file.size, 0);
  const receivedBytes = transferActivity.files.reduce((total, file) => total + file.received, 0);
  const catalogued = transferActivity.files.filter((file) => file.catalogued).length;
  const percent = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 0;
  const active = transferActivity.files.find((file) => file.id === transferActivity?.activeFileId);
  const heading = {
    receiving: "Receiving music from another computer",
    cataloguing: "Cataloguing completed song",
    finalizing: "Finalizing music transfer",
    complete: "Transfer complete",
    interrupted: "Transfer interrupted",
  }[transferActivity.phase];
  const detail = transferActivity.detail ?? active?.path ?? `Preparing ${transferActivity.files.length} files`;
  return `<section class="transfer-activity phase-${transferActivity.phase}" data-testid="local-transfer-status" aria-live="polite">
    <div class="transfer-activity-copy"><strong>${escapeHtml(heading)}</strong><span data-testid="local-transfer-file">${escapeHtml(detail)}</span></div>
    <div class="transfer-activity-progress">
      <span data-testid="local-transfer-count">${catalogued} of ${transferActivity.files.length} catalogued</span>
      <progress max="${Math.max(totalBytes, 1)}" value="${receivedBytes}" aria-label="Music transfer progress">${percent}%</progress>
      <span>${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)} · ${percent}%</span>
    </div>
  </section>`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KiB`;
  return `${(bytes / 1_048_576).toFixed(1)} MiB`;
}

function groupTracks(tracks: Track[], field: (track: Track) => string): Map<string, Track[]> {
  const groups = new Map<string, Track[]>();
  for (const track of tracks) {
    const key = field(track);
    const values = groups.get(key) ?? [];
    values.push(track);
    groups.set(key, values);
  }
  return groups;
}

function playlistById(id: string | undefined): Playlist | undefined {
  return snapshot?.playlists.find((playlist) => playlist.id === id);
}

function updateProgress(): void {
  const range = root.querySelector<HTMLInputElement>("[data-seek]");
  const label = root.querySelector<HTMLElement>("[data-current-time]");
  if (range) range.value = String(Math.min(positionMs, Number(range.max)));
  if (label) label.textContent = formatTime(positionMs);
}

function showMessage(text: string, error: boolean): void {
  message = { text, error };
  window.clearTimeout(messageTimer);
  messageTimer = window.setTimeout(() => {
    message = null;
    render();
  }, error ? 8_000 : 3_000);
  render();
}

function renderFatal(reason: string): void {
  root.innerHTML = `<main class="content"><h1>Zuradio could not start</h1><p class="notice error">${escapeHtml(reason)}</p><p class="muted">Launch the app again from the desktop shortcut or run <code>zuradio serve</code>.</p></main>`;
}

function renderEmpty(text: string): string {
  return `<div class="empty">${escapeHtml(text)}</div>`;
}

function disabled(): string {
  return busy ? "disabled" : "";
}

function numberData(value: string | undefined): number | null {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function formatTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatChatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Zuradio could not complete that action";
}

window.addEventListener("pagehide", () => {
  void bridge.stop();
  visualizer.destroy();
  audio.destroy();
});
