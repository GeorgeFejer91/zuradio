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
  printf 'Data-transfer gate blocked: build the optimized daemon with cargo build --release -p zuradio-daemon.\n' >&2
  exit 2
fi
if [ ! -f "$project_dir/web/dist/host/index.html" ]; then
  printf 'Data-transfer gate blocked: build production web assets with npm run build in web/.\n' >&2
  exit 2
fi
if [ -z "${ZURADIO_TEST_PASSWORD_FILE:-}" ]; then
  generated_password=$(mktemp "$project_dir/target/zuradio-transfer-password.XXXXXX")
  chmod 0600 "$generated_password"
  printf 'zuradio-transfer-gate-%s-%s\n' "$$" "$(date +%s)" > "$generated_password"
  ZURADIO_TEST_PASSWORD_FILE=$generated_password
  export ZURADIO_TEST_PASSWORD_FILE
fi

ZURADIO_TRANSFER_GATE=1 "$project_dir/scripts/qualify-browser.sh" \
  --project=chromium \
  tests/e2e/data-transfer.spec.ts
printf 'Zuradio staged data-transfer verification gate passed.\n'
