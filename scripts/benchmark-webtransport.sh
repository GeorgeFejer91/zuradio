#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
manifest="$project_dir/benchmarks/webtransport/Cargo.toml"
target_dir=${CARGO_TARGET_DIR:-$project_dir/target/webtransport-benchmark}
binary="$target_dir/release/zuradio-webtransport-benchmark"
benchmark_dir=$(mktemp -d "$project_dir/target/zuradio-webtransport.XXXXXX")
server_log="$benchmark_dir/server.log"
server_pid=

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" >/dev/null 2>&1 || true
    wait "$server_pid" >/dev/null 2>&1 || true
  fi
  rm -rf "$benchmark_dir"
}
trap cleanup EXIT INT TERM

CARGO_TARGET_DIR="$target_dir" cargo build --release --manifest-path "$manifest"
"$binary" >"$server_log" 2>&1 &
server_pid=$!

attempt=0
while [ "$attempt" -lt 200 ]; do
  if grep -q '^READY ' "$server_log"; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.05
done
if [ "$attempt" -ge 200 ]; then
  printf 'WebTransport benchmark server did not become ready.\n' >&2
  exit 1
fi

ready=$(sed -n 's/^READY //p' "$server_log" | head -1)
port=${ready%% *}
digest=${ready#* }
cd "$project_dir/web"
WEBTRANSPORT_PORT="$port" \
WEBTRANSPORT_DIGEST="$digest" \
node scripts/benchmark-webtransport.mjs
