#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${ZURADIO_BINARY:-$project_dir/target/release/zuradio}
music_dir=${ZURADIO_TEST_MUSIC:-}
web_root=${ZURADIO_WEB_ROOT:-$project_dir/web/dist}
companion_url=${ZURADIO_COMPANION_BASE:-http://127.0.0.1:4173}

if [ -z "$music_dir" ] || [ ! -d "$music_dir" ]; then
  printf 'Set ZURADIO_TEST_MUSIC to a folder containing at least three supported tracks.\n' >&2
  exit 2
fi
if [ ! -x "$binary" ]; then
  printf 'Zuradio binary is not executable: %s\n' "$binary" >&2
  exit 2
fi
if [ ! -d "$web_root" ]; then
  printf 'Zuradio web build is missing: %s\n' "$web_root" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  printf 'The CLI qualification requires jq.\n' >&2
  exit 2
fi

qualification_dir=$(mktemp -d)
data_dir="$qualification_dir/data"
server_log="$qualification_dir/server.log"
password_file="$qualification_dir/password.txt"
mkdir -p "$data_dir"
printf 'zuradio-test-password\n' >"$password_file"
chmod 0600 "$password_file"
server_pid=

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$qualification_dir"
}
trap cleanup EXIT INT TERM

"$binary" --data-dir "$data_dir" serve \
  --music "$music_dir" \
  --web-root "$web_root" \
  --no-open \
  --remote-password-file "$password_file" \
  --companion-url "$companion_url" >"$server_log" 2>&1 &
server_pid=$!

attempt=0
while [ "$attempt" -lt 100 ]; do
  if "$binary" --data-dir "$data_dir" status >"$qualification_dir/status.json" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$server_pid" >/dev/null 2>&1; then
    sed -n '1,120p' "$server_log" >&2
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$attempt" -ge 100 ]; then
  sed -n '1,120p' "$server_log" >&2
  printf 'Zuradio did not become ready for CLI qualification.\n' >&2
  exit 1
fi

zr() {
  "$binary" --data-dir "$data_dir" "$@"
}

zr scan "$music_dir" >"$qualification_dir/scan.json"
track_count=$(jq '.tracks | length' "$qualification_dir/scan.json")
if [ "$track_count" -lt 3 ]; then
  printf 'Expected at least three scanned tracks, received %s.\n' "$track_count" >&2
  exit 1
fi

track_one=$(jq -r '.tracks[0].id' "$qualification_dir/scan.json")
track_two=$(jq -r '.tracks[1].id' "$qualification_dir/scan.json")
track_three=$(jq -r '.tracks[2].id' "$qualification_dir/scan.json")
track_two_title=$(jq -r '.tracks[1].title' "$qualification_dir/scan.json")
search_term=$(printf '%s' "$track_two_title" | cut -c 1-4)
search_count=$(zr tracks --query "$search_term" | jq 'length')
if [ "$search_count" -lt 1 ]; then
  printf 'Track search did not return the expected fixture.\n' >&2
  exit 1
fi

zr queue clear >/dev/null
zr queue add "$track_one" >/dev/null
zr queue add "$track_two" >/dev/null
zr queue add "$track_three" >/dev/null
zr queue move 2 1 >/dev/null
zr queue remove 2 >/dev/null

zr play "$track_one" >/dev/null
zr pause >/dev/null
zr play >/dev/null
zr seek 1000 >/dev/null
zr next >/dev/null
zr previous >/dev/null
zr volume 33 >/dev/null
zr mute true >/dev/null
zr mute false >/dev/null
zr shuffle true >/dev/null
zr shuffle false >/dev/null
zr repeat all >/dev/null
zr repeat one >/dev/null
zr repeat off >/dev/null
zr stop >/dev/null

zr favorite "$track_one" true >/dev/null
zr favorite "$track_one" false >/dev/null

playlist_name="CLI Qualification"
renamed_playlist="CLI Qualification Renamed"
zr playlist create "$playlist_name" >/dev/null
playlist_id=$(zr playlist list | jq -r --arg name "$playlist_name" '.[] | select(.name == $name) | .id')
if [ -z "$playlist_id" ]; then
  printf 'Playlist creation was not reflected in canonical state.\n' >&2
  exit 1
fi
zr playlist add "$playlist_id" "$track_one" >/dev/null
zr playlist add "$playlist_id" "$track_two" >/dev/null
zr playlist move "$playlist_id" 1 0 >/dev/null
zr playlist remove "$playlist_id" 1 >/dev/null
zr playlist rename "$playlist_id" "$renamed_playlist" >/dev/null
zr playlist delete "$playlist_id" >/dev/null
zr queue clear >/dev/null

zr status >"$qualification_dir/final.json"
jq -e \
  --arg track "$track_one" \
  --arg playlist "$playlist_id" \
  '.player.status == "stopped"
   and .player.volume == 33
   and .player.muted == false
   and .player.shuffle == false
   and .player.repeat == "off"
   and (.player.queue | length) == 0
   and (.favorites | index($track) | not)
   and (.playlists | map(.id) | index($playlist) | not)' \
  "$qualification_dir/final.json" >/dev/null

printf 'Zuradio CLI qualification passed: scan/search, transport, seek, volume, mute, shuffle, repeat, queue, favorites, and playlist CRUD/reorder.\n'
