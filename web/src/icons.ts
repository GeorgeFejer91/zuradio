export type IconName =
  | "album"
  | "artist"
  | "broadcast"
  | "chevronDown"
  | "chevronUp"
  | "close"
  | "edit"
  | "heart"
  | "history"
  | "library"
  | "music"
  | "next"
  | "pause"
  | "play"
  | "playlist"
  | "plus"
  | "previous"
  | "queue"
  | "repeat"
  | "scan"
  | "shuffle"
  | "stop"
  | "upload"
  | "volume"
  | "volumeOff";

const paths: Record<IconName, string> = {
  album: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  artist: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14"/>',
  chevronDown: '<path d="m7 10 5 5 5-5"/>',
  chevronUp: '<path d="m7 14 5-5 5 5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  edit: '<path d="m4 20 4.5-1 10-10a2.1 2.1 0 0 0-3-3l-10 10L4 20Z"/><path d="m13.5 7.5 3 3"/>',
  heart: '<path d="M20.8 4.7a5.5 5.5 0 0 0-7.8 0L12 5.8l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8l1.1 1.1L12 21l7.8-7.4 1.1-1.1a5.5 5.5 0 0 0-.1-7.8Z"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  library: '<path d="M4 4v16M9 4v16M14 6v14M19 3v17"/><path d="M2 20h20"/>',
  music: '<path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  next: '<path d="m6 5 10 7-10 7V5Z"/><path d="M19 5v14"/>',
  pause: '<path d="M8 5v14M16 5v14"/>',
  play: '<path d="m7 4 12 8-12 8V4Z"/>',
  playlist: '<path d="M4 6h10M4 11h10M4 16h7"/><path d="M17 14v6"/><circle cx="14.5" cy="20" r="2.5"/><path d="m17 14 4-1v4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  previous: '<path d="m18 5-10 7 10 7V5Z"/><path d="M5 5v14"/>',
  queue: '<path d="M4 6h12M4 12h9M4 18h6"/><path d="m16 15 4 3-4 3v-6Z"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/>',
  scan: '<path d="M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4"/><path d="M7 12h10"/>',
  shuffle: '<path d="M4 6h2.5c4.5 0 6.5 12 11 12H20"/><path d="m17 15 3 3-3 3M4 18h2.5c1.8 0 3.2-1.8 4.5-4M14 8c1-1.2 2.1-2 3.5-2H20"/><path d="m17 3 3 3-3 3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M5 20h14"/>',
  volume: '<path d="M5 9H2v6h3l5 4V5L5 9Z"/><path d="M14 9a4 4 0 0 1 0 6M17 6a8 8 0 0 1 0 12"/>',
  volumeOff: '<path d="M5 9H2v6h3l5 4V5L5 9Z"/><path d="m15 9 6 6M21 9l-6 6"/>',
};

export function icon(name: IconName, className = ""): string {
  return `<svg class="ui-icon${className ? ` ${className}` : ""}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}
