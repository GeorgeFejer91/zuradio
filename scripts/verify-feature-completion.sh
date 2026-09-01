#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ ! -x "$project_dir/target/release/zuradio" ]; then
  printf 'Browser gate blocked: build the optimized daemon with cargo build --release -p zuradio-daemon.\n' >&2
  exit 2
fi
if [ ! -f "$project_dir/web/dist/host/index.html" ]; then
  printf 'Browser gate blocked: build production web assets with npm run build in web/.\n' >&2
  exit 2
fi

"$project_dir/scripts/qualify-browser.sh" "$@"
printf 'Zuradio browser verification gate passed.\n'
