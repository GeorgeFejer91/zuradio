#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
output_dir="$project_dir/tests/fixtures/open-music"
download_dir=$(mktemp -d)

cleanup() {
  rm -rf "$download_dir"
}
trap cleanup EXIT INT TERM

git clone --depth 1 --filter=blob:none --no-checkout \
  https://github.com/0lhi/FreePD.git "$download_dir/freepd"
git -C "$download_dir/freepd" sparse-checkout init --no-cone
git -C "$download_dir/freepd" sparse-checkout set \
  '/Electronic/Arpent.mp3' \
  '/Epic/Adventure.mp3' \
  '/World/Nomadic Sunset.mp3' \
  '/LICENSE'
git -C "$download_dir/freepd" checkout

mkdir -p "$output_dir"
install -m 0644 "$download_dir/freepd/Electronic/Arpent.mp3" "$output_dir/Arpent.mp3"
install -m 0644 "$download_dir/freepd/Epic/Adventure.mp3" "$output_dir/Adventure.mp3"
install -m 0644 "$download_dir/freepd/World/Nomadic Sunset.mp3" "$output_dir/Nomadic Sunset.mp3"

cd "$output_dir"
printf '%s  %s\n' \
  'ef06d8b524c196a31954dfb1f3261e7d37459e43f4afd9df31ee2965c6094a56' 'Arpent.mp3' \
  '18432184e1a3acf8095b8b45b688fe08f7afb2447fc6e3adc98cc944c541a733' 'Adventure.mp3' \
  '9b169280913ade05f804050a1887e6047a4f3dba85ec32101a20fcd62b884d72' 'Nomadic Sunset.mp3' \
  | sha256sum --check --strict
