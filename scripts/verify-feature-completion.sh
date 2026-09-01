#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
generated_password=

cleanup() {
  if [ -n "$generated_password" ] && [ -f "$generated_password" ]; then
    rm -f -- "$generated_password"
  fi
}
trap cleanup EXIT INT TERM

if [ ! -x "$project_dir/target/release/zuradio" ]; then
  printf 'Browser gate blocked: build the optimized daemon with cargo build --release -p zuradio-daemon.\n' >&2
  exit 2
fi
if [ ! -f "$project_dir/web/dist/host/index.html" ]; then
  printf 'Browser gate blocked: build production web assets with npm run build in web/.\n' >&2
  exit 2
fi
if [ -z "${ZURADIO_TEST_PASSWORD_FILE:-}" ]; then
  generated_password=$(mktemp "$project_dir/target/zuradio-gate-password.XXXXXX")
  chmod 0600 "$generated_password"
  printf 'zuradio-browser-gate-%s-%s\n' "$$" "$(date +%s)" > "$generated_password"
  ZURADIO_TEST_PASSWORD_FILE=$generated_password
  export ZURADIO_TEST_PASSWORD_FILE
fi

"$project_dir/scripts/qualify-browser.sh" "$@"
printf 'Zuradio browser verification gate passed.\n'
