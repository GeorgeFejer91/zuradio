import "./style.css";

import { ZuradioApi } from "./api";
import { AudioEngine } from "./audio-engine";
import type { Action, AppSnapshot, BroadcastSession, Playlist, Track } from "./types";
import { HostBroadcastBridge } from "./vdo";

type View = "library" | "albums" | "artists" | "playlists" | "favorites" | "history" | "broadcast";

const rootElement = document.querySelector<HTMLDivElement>("#app");
if (!rootElement) throw new Error("Missing app root");
const root: HTMLDivElement = rootElement;

const api = new ZuradioApi();
let snapshot: AppSnapshot | null = null;
let view: View = "library";
let search = "";
let selectedPlaylistId: string | null = null;
let editingTrackId: string | null = null;
let broadcastSession: BroadcastSession | null = null;
let busy = false;
let message: { text: string; error: boolean } | null = null;
let positionMs = 0;
let messageTimer = 0;
let pendingTasks = 0;
let taskTail: Promise<void> = Promise.resolve();

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

const bridge = new HostBroadcastBridge({
  snapshot: () => {
    if (!api.currentSnapshot) throw new Error("Player state is unavailable");
    return api.currentSnapshot;
  },
  verify: (payload) => api.verifyRemote(payload),
  action: async (payload) => {
    const result = await api.remoteAction(payload);
    const current = api.currentSnapshot;
    if (current) {
      snapshot = current;
      await audio.sync(current);
      render();
    }
    return result;
  },
  upload: async (payload) => {
    const result = await api.remoteUpload(payload);
    snapshot = api.currentSnapshot;
    render();
    return result;
  },
  onError: (reason) => showMessage(reason, true),
});

root.addEventListener("click", (event) => {
  const target = (event.target as HTMLElement).closest<HTMLElement>("[data-action]");
  if (!target || busy) return;
  void handleClick(target);
});

root.addEventListener("submit", (event) => {
  const form = event.target as HTMLFormElement;
  event.preventDefault();
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
  const target = event.target as HTMLInputElement;
  if (target.matches("[data-search]")) {
    search = target.value;
    render();
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
    audio.seek(value);
    void perform({ kind: "seek", positionMs: value });
  }
});

void initialize();

async function initialize(): Promise<void> {
  try {
    snapshot = await api.bootstrap();
    positionMs = snapshot.player.positionMs;
    broadcastSession = await api.broadcastStatus();
    selectedPlaylistId = snapshot.playlists[0]?.id ?? null;
    await audio.sync(snapshot);
    api.subscribe((next) => {
      snapshot = next;
      positionMs = next.player.positionMs;
      void audio.sync(next).catch((error: unknown) => showMessage(messageOf(error), true));
      bridge.publishState(next);
      render();
    });
    render();
  } catch (error) {
    renderFatal(messageOf(error));
  }
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
      showMessage(`Library scan complete: ${snapshot.tracks.length} tracks`, false);
      render();
    });
    return;
  }
  if (action === "select-playlist") {
    selectedPlaylistId = target.dataset.playlistId ?? null;
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
    await task(async () => {
      await audio.unlock();
      const session = await api.startBroadcast();
      try {
        await bridge.start(session, audio.broadcastStream);
        broadcastSession = session;
        showMessage("Broadcast started", false);
      } catch (error) {
        await api.stopBroadcast().catch(() => undefined);
        throw error;
      }
      render();
    });
    return;
  }
  if (action === "stop-broadcast") {
    await task(async () => {
      await bridge.stop();
      await api.stopBroadcast();
      broadcastSession = null;
      showMessage("Broadcast stopped; old invitations are revoked", false);
      render();
    });
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

async function perform(action: Action, unlock = true): Promise<void> {
  await task(async () => {
    if (unlock && (action.kind === "play" || action.kind === "play_track")) await audio.unlock();
    await api.action(action);
    snapshot = api.currentSnapshot;
    if (snapshot) {
      positionMs = snapshot.player.positionMs;
      await audio.sync(snapshot);
      bridge.publishState(snapshot);
    }
    render();
  });
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
  root.innerHTML = `
    <div class="shell" aria-busy="${busy}">
      ${renderSidebar(snapshot)}
      <main class="main">
        <div class="toolbar">
          <input class="search" data-search data-testid="search" type="search" value="${escapeAttribute(search)}" placeholder="Search title, artist, or album" aria-label="Search library" />
          <span class="toolbar-spacer"></span>
          <button data-action="scan" data-testid="scan-library" ${disabled()}>Scan library</button>
        </div>
        <div class="content">${renderContent(snapshot)}</div>
      </main>
      ${renderQueue(snapshot)}
    </div>
    ${renderPlayer(snapshot)}
    ${editingTrackId ? renderMetadataEditor(snapshot) : ""}
    <div class="status-line${message?.error ? " error" : ""}" role="status" aria-live="polite" ${message ? "" : "hidden"}>${escapeHtml(message?.text ?? "")}</div>
  `;
  updateProgress();
}

function renderSidebar(state: AppSnapshot): string {
  const items: Array<[View, string, number | string]> = [
    ["library", "Library", state.tracks.length],
    ["albums", "Albums", unique(state.tracks.map((track) => track.album)).length],
    ["artists", "Artists", unique(state.tracks.map((track) => track.artist)).length],
    ["playlists", "Playlists", state.playlists.length],
    ["favorites", "Favorites", state.favorites.length],
    ["history", "History", state.history.length],
    ["broadcast", "Broadcast", broadcastSession ? "On" : "Off"],
  ];
  return `<aside class="sidebar">
    <div class="brand"><h1>Zuradio</h1><p>Music on this laptop</p></div>
    <nav class="nav" aria-label="Music library">
      ${items
        .map(
          ([id, label, count]) => `<button data-action="nav" data-view="${id}" aria-current="${view === id ? "page" : "false"}">
            <span>${label}</span><span class="nav-count">${count}</span>
          </button>`,
        )
        .join("")}
    </nav>
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
      return renderGroups("Albums", groupTracks(state.tracks, (track) => track.album));
    case "artists":
      return renderGroups("Artists", groupTracks(state.tracks, (track) => track.artist));
    case "playlists":
      return renderPlaylists(state);
    case "history":
      return renderHistory(state);
    case "broadcast":
      return renderBroadcast();
  }
}

function renderTrackSection(title: string, tracks: Track[], state: AppSnapshot): string {
  return `<div class="section-header"><h2>${title}</h2><span class="muted">${tracks.length} tracks</span></div>
    ${tracks.length ? `<ol class="track-list">${tracks.map((track) => renderTrack(track, state)).join("")}</ol>` : renderEmpty("No matching tracks")}`;
}

function renderTrack(track: Track, state: AppSnapshot): string {
  const favorite = state.favorites.includes(track.id);
  const playlist = selectedPlaylistId ? state.playlists.find((item) => item.id === selectedPlaylistId) : state.playlists[0];
  return `<li class="track-row" data-track-row="${escapeAttribute(track.id)}">
    <button class="icon" data-action="play-track" data-track-id="${escapeAttribute(track.id)}" aria-label="Play ${escapeAttribute(track.title)}" title="Play">▶</button>
    <div class="track-title"><strong>${escapeHtml(track.title)}</strong><span>${escapeHtml(track.format.toUpperCase())}${track.year ? ` · ${track.year}` : ""}</span></div>
    <div class="track-cell track-artist">${escapeHtml(track.artist)}</div>
    <div class="track-cell track-album">${escapeHtml(track.album)}</div>
    <div class="track-duration">${formatTime(track.durationMs)}</div>
    <div class="track-actions">
      <button data-action="favorite" data-track-id="${escapeAttribute(track.id)}" data-enabled="${!favorite}" aria-label="${favorite ? "Remove from" : "Add to"} favorites" title="Favorite">${favorite ? "★" : "☆"}</button>
      <button data-action="queue-add" data-track-id="${escapeAttribute(track.id)}" aria-label="Add ${escapeAttribute(track.title)} to queue" title="Add to queue">＋</button>
      ${playlist ? `<button data-action="playlist-add" data-playlist-id="${escapeAttribute(playlist.id)}" data-track-id="${escapeAttribute(track.id)}" aria-label="Add to ${escapeAttribute(playlist.name)}" title="Add to ${escapeAttribute(playlist.name)}">↳</button>` : ""}
      <button data-action="edit-track" data-track-id="${escapeAttribute(track.id)}" aria-label="Edit metadata for ${escapeAttribute(track.title)}" title="Edit metadata">✎</button>
    </div>
  </li>`;
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
        <div class="metadata-actions"><button type="button" data-action="close-metadata">Cancel</button><button class="primary" data-testid="save-metadata">Save changes</button></div>
      </form>
    </section>
  </div>`;
}

function renderGroups(title: string, groups: Map<string, Track[]>): string {
  const ordered = [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  return `<div class="section-header"><h2>${title}</h2><span class="muted">${ordered.length}</span></div>
    ${ordered.length ? `<ul class="group-list">${ordered
      .map(
        ([name, tracks]) => `<li class="group-item"><button data-action="group" data-query="${escapeAttribute(name)}"><strong>${escapeHtml(name)}</strong></button><p>${tracks.length} track${tracks.length === 1 ? "" : "s"}</p></li>`,
      )
      .join("")}</ul>` : renderEmpty(`No ${title.toLowerCase()} yet`)}`;
}

function renderPlaylists(state: AppSnapshot): string {
  const selected = state.playlists.find((playlist) => playlist.id === selectedPlaylistId) ?? state.playlists[0];
  if (selected && selected.id !== selectedPlaylistId) selectedPlaylistId = selected.id;
  return `<div class="section-header"><h2>Playlists</h2><span class="muted">Stored on this laptop</span></div>
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
                <button data-action="rename-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-label="Rename ${escapeAttribute(playlist.name)}">✎</button>
                <button class="danger" data-action="delete-playlist" data-playlist-id="${escapeAttribute(playlist.id)}" aria-label="Delete ${escapeAttribute(playlist.name)}">×</button>
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
            <button data-action="playlist-move" data-playlist-id="${escapeAttribute(playlist.id)}" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
            <button data-action="playlist-move" data-playlist-id="${escapeAttribute(playlist.id)}" data-from="${index}" data-to="${Math.min(playlist.trackIds.length - 1, index + 1)}" aria-label="Move down" ${index === playlist.trackIds.length - 1 ? "disabled" : ""}>↓</button>
            <button data-action="playlist-remove" data-playlist-id="${escapeAttribute(playlist.id)}" data-index="${index}" aria-label="Remove from playlist">×</button>
          </span>
        </li>`;
      })
      .join("")}</ol>` : renderEmpty("This playlist is empty. Select it, then add tracks from Library.")}`;
}

function renderHistory(state: AppSnapshot): string {
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  const tracks = state.history.map((entry) => byId.get(entry.trackId)).filter((track): track is Track => Boolean(track));
  return renderTrackSection("Recently played", tracks, state);
}

function renderBroadcast(): string {
  if (!broadcastSession) {
    return `<section class="broadcast-panel">
      <h2>Broadcast</h2>
      <div class="broadcast-status"><strong>Off</strong><p class="muted">No remote peer can hear or control this laptop.</p></div>
      <p>Starting a broadcast creates fresh password-gated listen, control, and upload invitations. Music stays on this laptop; the companion receives live audio or sends files directly to this app.</p>
      <button class="primary" data-action="start-broadcast" data-testid="start-broadcast" ${disabled()}>Start broadcast</button>
    </section>`;
  }
  return `<section class="broadcast-panel">
    <h2>Broadcast</h2>
    <div class="broadcast-status live"><strong>Live</strong><p class="muted">Audio originates from this player. Stopping revokes every invitation and partial upload.</p></div>
    <button class="danger" data-action="stop-broadcast" data-testid="stop-broadcast" ${disabled()}>Stop broadcast</button>
    ${renderInvitation("Listener invitation", "Listen only; no player or playlist controls.", broadcastSession.listenerInvitation, "listener-invitation")}
    ${renderInvitation("Controller invitation", "Can listen and use the typed player, queue, and playlist controls.", broadcastSession.controllerInvitation, "controller-invitation")}
    ${renderInvitation("Upload invitation", "Can select files or a folder and add supported music to this laptop.", broadcastSession.uploadInvitation, "upload-invitation")}
  </section>`;
}

function renderInvitation(label: string, description: string, value: string, testId: string): string {
  return `<div class="invitation"><label>${label}</label><p class="muted">${description}</p><div class="invitation-row">
    <input readonly data-testid="${testId}" value="${escapeAttribute(value)}" aria-label="${label}" />
    <button data-action="copy" data-value="${escapeAttribute(value)}">Copy</button>
  </div></div>`;
}

function renderQueue(state: AppSnapshot): string {
  const byId = new Map(state.tracks.map((track) => [track.id, track]));
  return `<aside class="right-panel"><div class="right-header"><h2>Queue</h2><button data-action="queue-clear" ${state.player.queue.length ? "" : "disabled"}>Clear</button></div>
    ${state.player.queue.length ? `<ol class="queue-list">${state.player.queue
      .map((id, index) => {
        const track = byId.get(id);
        return `<li class="queue-item${index === state.player.queueCursor ? " current" : ""}">
          <span class="queue-index">${index + 1}</span>
          <span class="track-title"><strong>${escapeHtml(track?.title ?? "Unavailable")}</strong><span>${escapeHtml(track?.artist ?? "")}</span></span>
          <span class="queue-buttons">
            <button data-action="queue-move" data-from="${index}" data-to="${Math.max(0, index - 1)}" aria-label="Move up" ${index === 0 ? "disabled" : ""}>↑</button>
            <button data-action="queue-move" data-from="${index}" data-to="${Math.min(state.player.queue.length - 1, index + 1)}" aria-label="Move down" ${index === state.player.queue.length - 1 ? "disabled" : ""}>↓</button>
            <button data-action="queue-remove" data-index="${index}" aria-label="Remove from queue">×</button>
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
    <div class="now-playing${track?.hasArtwork ? " has-artwork" : ""}">
      ${track?.hasArtwork ? `<img class="album-art" src="${escapeAttribute(api.artworkUrl(track.id))}" alt="" />` : ""}
      <div class="now-copy"><strong data-testid="now-title">${escapeHtml(track?.title ?? "Nothing playing")}</strong><span>${escapeHtml(track?.artist ?? "Choose a track from the library")}</span></div>
    </div>
    <div class="transport">
      <div class="transport-buttons">
        <button class="icon" data-action="previous" aria-label="Previous track">⏮</button>
        <button class="icon" data-action="${playing ? "pause" : "play"}" data-testid="play-pause" aria-label="${playing ? "Pause" : "Play"}">${playing ? "❚❚" : "▶"}</button>
        <button class="icon" data-action="next" aria-label="Next track">⏭</button>
        <button class="icon" data-action="stop" aria-label="Stop">■</button>
      </div>
      <div class="progress-row">
        <span class="time" data-current-time>${formatTime(positionMs)}</span>
        <input data-seek data-testid="seek" type="range" min="0" max="${Math.max(duration, 1)}" step="250" value="${Math.min(positionMs, Math.max(duration, 1))}" aria-label="Seek position" ${track ? "" : "disabled"} />
        <span class="time">${formatTime(duration)}</span>
      </div>
    </div>
    <div class="output-controls">
      <button class="shuffle-button${state.player.shuffle ? " active" : ""}" data-action="shuffle" aria-pressed="${state.player.shuffle}" aria-label="Shuffle">⇄</button>
      <button class="repeat-button${state.player.repeat !== "off" ? " active" : ""}" data-action="repeat" aria-label="Repeat mode: ${state.player.repeat}">${state.player.repeat === "one" ? "↻1" : "↻"}</button>
      <button class="icon" data-action="mute" aria-label="${state.player.muted ? "Unmute" : "Mute"}">${state.player.muted ? "🔇" : "🔊"}</button>
      <input data-volume data-testid="volume" type="range" min="0" max="100" value="${state.player.volume}" aria-label="Volume" />
    </div>
  </footer>`;
}

function filteredTracks(state: AppSnapshot): Track[] {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return state.tracks;
  return state.tracks.filter((track) =>
    [track.title, track.artist, track.album].some((value) => value.toLocaleLowerCase().includes(query)),
  );
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
  audio.destroy();
});
