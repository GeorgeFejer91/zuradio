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

mkdir -p "$project_dir/target"
if [ -z "${ZURADIO_TEST_PASSWORD_FILE:-}" ]; then
  generated_password=$(mktemp "$project_dir/target/zuradio-gate-password.XXXXXX")
  chmod 0600 "$generated_password"
  printf 'zuradio-browser-gate-%s-%s\n' "$$" "$(date +%s)" > "$generated_password"
  ZURADIO_TEST_PASSWORD_FILE=$generated_password
  export ZURADIO_TEST_PASSWORD_FILE
fi

"$project_dir/scripts/verify-data-transfer.sh"
ZURADIO_TRANSFER_GATE=0 "$project_dir/scripts/qualify-browser.sh" "$@"
printf 'Zuradio browser verification gate passed.\n'
