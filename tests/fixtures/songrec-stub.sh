#!/bin/sh
set -eu

if [ "${1:-}" != "recognize" ] || [ "${2:-}" != "--json" ] || [ ! -f "${3:-}" ]; then
  printf 'invalid SongRec fixture invocation\n' >&2
  exit 2
fi

printf '%s\n' '{"matches":[{"id":"zuradio-verification-match"}],"track":{"key":"zuradio-verification-track","title":"Verified Acoustic Match","subtitle":"Zuradio Test Artist","genres":{"primary":"Verification Electronica"},"sections":[{"metadata":[{"title":"Album","text":"Acoustic Verification Collection"}]}]}}'
