#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
binary=${ZURADIO_BINARY:-$project_dir/target/release/zuradio}
fixture_dir=${ZURADIO_TEST_MUSIC:-$project_dir/tests/fixtures/open-music}
copies=${ZURADIO_BENCHMARK_COPIES:-20}
scan_limit_ms=${ZURADIO_SCAN_LIMIT_MS:-15000}
snapshot_limit_ms=${ZURADIO_SNAPSHOT_LIMIT_MS:-1000}
stream_floor_bps=${ZURADIO_STREAM_FLOOR_BPS:-1000000}
rss_limit_kib=${ZURADIO_RSS_LIMIT_KIB:-307200}

if [ ! -x "$binary" ]; then
  printf 'Build the optimized daemon first: cargo build --release -p zuradio-daemon\n' >&2
  exit 2
fi
if [ ! -f "$fixture_dir/Arpent.mp3" ]; then
  printf 'Download the open music fixtures first: scripts/fetch-test-music.sh\n' >&2
  exit 2
fi

mkdir -p "$project_dir/target"
benchmark_dir=$(mktemp -d "$project_dir/target/zuradio-benchmark.XXXXXX")
data_dir="$benchmark_dir/data"
corpus_dir="$benchmark_dir/corpus"
library_dir="$benchmark_dir/library"
password_file="$benchmark_dir/password.txt"
mkdir -p "$data_dir" "$corpus_dir" "$library_dir"
printf 'zuradio-performance-password\n' >"$password_file"
chmod 0600 "$password_file"
server_pid=

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$benchmark_dir"
}
trap cleanup EXIT INT TERM

index=1
while [ "$index" -le "$copies" ]; do
  album_dir="$corpus_dir/Fixture Artist $index/Fixture Album $index (2024)"
  mkdir -p "$album_dir"
  ln "$fixture_dir/Arpent.mp3" "$album_dir/01 - Arpent $index.mp3"
  ln "$fixture_dir/Adventure.mp3" "$album_dir/02 - Adventure $index.mp3"
  ln "$fixture_dir/Nomadic Sunset.mp3" "$album_dir/03 - Nomadic Sunset $index.mp3"
  index=$((index + 1))
done
track_count=$((copies * 3))

"$binary" --data-dir "$data_dir" serve \
  --music "$corpus_dir" \
  --library "$library_dir" \
  --web-root "$project_dir/web/dist" \
  --no-open \
  --remote-password-file "$password_file" >/dev/null 2>&1 &
server_pid=$!

attempt=0
while [ "$attempt" -lt 100 ]; do
  if "$binary" --data-dir "$data_dir" status >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$attempt" -ge 100 ]; then
  printf 'Benchmark daemon did not become ready.\n' >&2
  exit 1
fi

scan_total_ms=0
scan_iteration=1
while [ "$scan_iteration" -le 5 ]; do
  started_ns=$(date +%s%N)
  "$binary" --data-dir "$data_dir" scan "$corpus_dir" >"$benchmark_dir/scan.json"
  ended_ns=$(date +%s%N)
  scan_ms=$(((ended_ns - started_ns) / 1000000))
  scan_total_ms=$((scan_total_ms + scan_ms))
  scan_iteration=$((scan_iteration + 1))
done
scan_average_ms=$((scan_total_ms / 5))
catalogued=$(jq '.tracks | length' "$benchmark_dir/scan.json")

base_url=$(jq -r '.baseUrl' "$data_dir/runtime.json")
cli_token=$(jq -r '.cliToken' "$data_dir/runtime.json")
track_id=$(jq -r '.tracks[0].id' "$benchmark_dir/scan.json")
started_ns=$(date +%s%N)
curl --fail --silent --show-error \
  -H "Authorization: Bearer $cli_token" \
  "$base_url/api/v1/snapshot" >/dev/null
ended_ns=$(date +%s%N)
snapshot_ms=$(((ended_ns - started_ns) / 1000000))
stream_bps=$(curl --fail --silent --show-error \
  -H "Authorization: Bearer $cli_token" \
  -H 'Range: bytes=0-2097151' \
  --output /dev/null \
  --write-out '%{speed_download}' \
  "$base_url/api/v1/media/$track_id")
rss_kib=$(awk '/VmRSS:/ { print $2 }' "/proc/$server_pid/status")

jq -n \
  --argjson tracks "$catalogued" \
  --argjson scanAverageMs "$scan_average_ms" \
  --argjson snapshotMs "$snapshot_ms" \
  --argjson streamBytesPerSecond "${stream_bps%.*}" \
  --argjson rssKiB "$rss_kib" \
  '{tracks: $tracks, scanIterations: 5, scanAverageMs: $scanAverageMs, snapshotMs: $snapshotMs, streamBytesPerSecond: $streamBytesPerSecond, rssKiB: $rssKiB}'

if [ "$catalogued" -ne "$track_count" ] \
  || [ "$scan_average_ms" -gt "$scan_limit_ms" ] \
  || [ "$snapshot_ms" -gt "$snapshot_limit_ms" ] \
  || [ "${stream_bps%.*}" -lt "$stream_floor_bps" ] \
  || [ "$rss_kib" -gt "$rss_limit_kib" ]; then
  printf 'Zuradio performance threshold failed.\n' >&2
  exit 1
fi
