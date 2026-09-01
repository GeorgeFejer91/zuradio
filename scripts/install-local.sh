#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_root="$HOME/.local/lib/zuradio"
binary_dir="$HOME/.local/bin"
service_dir="$HOME/.config/systemd/user"
desktop_dir="$HOME/.local/share/applications"
icon_dir="$HOME/.local/share/icons/hicolor/scalable/apps"
data_dir="$HOME/.local/share/zuradio"

cd "$project_dir/web"
npm ci
npm run typecheck
npm test
npm run build

cd "$project_dir"
cargo test --workspace --exclude zuradio-desktop
cargo build --release -p zuradio-daemon

mkdir -p "$install_root/web" "$binary_dir" "$service_dir" "$desktop_dir" "$icon_dir" "$data_dir"
chmod 0700 "$data_dir"
install -m 0755 "$project_dir/target/release/zuradio" "$install_root/zuradio"
install -m 0755 "$project_dir/target/release/zuradio" "$binary_dir/zuradio"
install -m 0755 "$project_dir/packaging/linux/zuradio-launch" "$binary_dir/zuradio-launch"
install -m 0644 "$project_dir/packaging/linux/zuradio.service" "$service_dir/zuradio.service"
install -m 0644 "$project_dir/packaging/icons/zuradio.svg" "$icon_dir/zuradio.svg"
mkdir -p "$install_root/web"
cp -R "$project_dir/web/dist/." "$install_root/web/"

launcher_path="$binary_dir/zuradio-launch"
sed "s|@LAUNCHER@|$launcher_path|g" "$project_dir/packaging/linux/zuradio.desktop" > "$desktop_dir/zuradio.desktop"
chmod 0644 "$desktop_dir/zuradio.desktop"

systemctl --user daemon-reload
systemctl --user enable zuradio.service
systemctl --user restart zuradio.service

attempt=0
while [ "$attempt" -lt 100 ]; do
  if "$binary_dir/zuradio" status >/dev/null 2>&1; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 0.1
done
if [ "$attempt" -ge 100 ]; then
  printf 'Zuradio service did not become ready. Inspect it with: systemctl --user status zuradio.service\n' >&2
  exit 1
fi

music_dir=$(xdg-user-dir MUSIC 2>/dev/null || true)
if [ -n "$music_dir" ] && [ -d "$music_dir" ]; then
  "$binary_dir/zuradio" scan "$music_dir" >/dev/null
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$desktop_dir" || true
printf 'Zuradio installed. Launch it from the application menu or run: %s\n' "$binary_dir/zuradio-launch"
