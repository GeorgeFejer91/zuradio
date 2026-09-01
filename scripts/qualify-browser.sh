#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${ZURADIO_BINARY:-$project_dir/target/release/zuradio}
web_root=${ZURADIO_WEB_ROOT:-$project_dir/web/dist}
music_dir=${ZURADIO_TEST_MUSIC:-$project_dir/tests/fixtures/open-music}
companion_base=${ZURADIO_COMPANION_BASE:-http://127.0.0.1:4173}
password_source=${ZURADIO_TEST_PASSWORD_FILE:-}

if [ -z "$password_source" ]; then
  for candidate in "$HOME/Desktop/zuradio.txt" "$HOME/Schreibtisch/zuradio.txt"; do
    if [ -f "$candidate" ]; then
      password_source=$candidate
      break
    fi
  done
fi
if [ ! -f "$password_source" ]; then
  printf 'Set ZURADIO_TEST_PASSWORD_FILE to a password file containing 8 to 256 bytes.\n' >&2
  exit 2
fi
if [ ! -x "$binary" ]; then
  printf 'Build the optimized daemon first: cargo build --release -p zuradio-daemon\n' >&2
  exit 2
fi
if [ ! -f "$music_dir/Arpent.mp3" ]; then
  printf 'Download the open fixtures first: scripts/fetch-test-music.sh\n' >&2
  exit 2
fi

qualification_dir=$(mktemp -d "$project_dir/target/zuradio-browser.XXXXXX")
data_dir="$qualification_dir/data"
format_dir="$qualification_dir/formats"
password_file="$qualification_dir/password.txt"
install -m 0600 "$password_source" "$password_file"
mkdir -p "$format_dir"
format_fixtures=0
if command -v sox >/dev/null 2>&1 && command -v flac >/dev/null 2>&1; then
  sox -n -r 44100 -c 2 "$format_dir/Zuradio Format WAV.wav" synth 1 sine 440 >/dev/null 2>&1
  sox "$format_dir/Zuradio Format WAV.wav" "$format_dir/Zuradio Format AIFF.aiff" >/dev/null 2>&1
  sox "$format_dir/Zuradio Format WAV.wav" "$format_dir/Zuradio Format MP3.mp3" >/dev/null 2>&1
  sox "$format_dir/Zuradio Format WAV.wav" "$format_dir/Zuradio Format OGG.ogg" >/dev/null 2>&1
  flac --silent --force --output-name="$format_dir/Zuradio Format FLAC.flac" "$format_dir/Zuradio Format WAV.wav" 2>/dev/null
  format_fixtures=1
fi
daemon_pid=
preview_pid=

cleanup() {
  if [ -n "$daemon_pid" ]; then
    kill "$daemon_pid" >/dev/null 2>&1 || true
    wait "$daemon_pid" >/dev/null 2>&1 || true
  fi
  if [ -n "$preview_pid" ]; then
    kill "$preview_pid" >/dev/null 2>&1 || true
    wait "$preview_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$qualification_dir"
}
trap cleanup EXIT INT TERM

"$binary" --data-dir "$data_dir" serve \
  --music "$music_dir" \
  --music "$format_dir" \
  --web-root "$web_root" \
  --no-open \
  --companion-url "$companion_base" \
  --remote-password-file "$password_file" >/dev/null 2>&1 &
daemon_pid=$!
(cd "$project_dir/web" && npm run preview -- --host 127.0.0.1 --port 4173) >/dev/null 2>&1 &
preview_pid=$!

attempt=0
while [ "$attempt" -lt 150 ]; do
  if [ -f "$data_dir/runtime.json" ] \
    && "$binary" --data-dir "$data_dir" status >/dev/null 2>&1 \
    && curl --fail --silent "$companion_base" >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$attempt" -ge 150 ]; then
  printf 'Browser qualification services did not become ready.\n' >&2
  exit 1
fi

"$binary" --data-dir "$data_dir" scan "$music_dir" "$format_dir" >/dev/null

cd "$project_dir/web"
ZURADIO_RUNTIME="$data_dir/runtime.json" \
ZURADIO_TEST_PASSWORD_FILE="$password_file" \
ZURADIO_UPLOAD_FIXTURE="$music_dir/Arpent.mp3" \
ZURADIO_UPLOAD_FOLDER="$music_dir" \
ZURADIO_UPLOAD_EXPECTED_TITLE="Arpent" \
ZURADIO_FORMAT_FIXTURES="$format_fixtures" \
ZURADIO_COMPANION_BASE="$companion_base" \
npx playwright test "$@"
