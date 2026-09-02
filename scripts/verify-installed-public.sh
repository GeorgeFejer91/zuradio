#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

if [ -z "${ZURADIO_TEST_PASSWORD_FILE:-}" ]; then
  printf 'Set ZURADIO_TEST_PASSWORD_FILE to the installed password file.\n' >&2
  exit 2
fi

cleanup() {
  systemctl --user unset-environment ZURADIO_QUALIFICATION_INSPECTOR >/dev/null 2>&1 || true
  systemctl --user restart zuradio-host.service >/dev/null 2>&1 || true
}
trap cleanup EXIT

systemctl --user set-environment ZURADIO_QUALIFICATION_INSPECTOR=1
systemctl --user restart zuradio-host.service

inspector_ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl --fail --silent --show-error http://127.0.0.1:9224/json/version >/dev/null 2>&1; then
    inspector_ready=1
    break
  fi
  sleep 1
done

if [ "$inspector_ready" != 1 ]; then
  printf 'The temporary installed Chromium inspection endpoint did not become ready.\n' >&2
  exit 1
fi

cd "$project_dir/web"
node scripts/verify-installed-public.mjs
