#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
install_root="$HOME/.local/lib/zuradio"
binary_dir="$HOME/.local/bin"
service_dir="$HOME/.config/systemd/user"
desktop_dir="$HOME/.local/share/applications"
icon_theme_dir="$HOME/.local/share/icons/hicolor"
icon_dir="$icon_theme_dir/512x512/apps"
legacy_icon="$icon_theme_dir/scalable/apps/zuradio.svg"
data_dir="$HOME/.local/share/zuradio"
music_dir=$(xdg-user-dir MUSIC 2>/dev/null || true)
if [ -z "$music_dir" ]; then
  music_dir="$HOME/Music"
fi
library_dir="$music_dir/Zuradio Library"

cd "$project_dir/web"
npm ci
npm run typecheck
npm test
npm run build

cd "$project_dir"
cargo test --workspace --exclude zuradio-desktop
cargo build --release -p zuradio-daemon

mkdir -p "$install_root/web" "$binary_dir" "$service_dir" "$desktop_dir" "$icon_dir" "$data_dir" "$library_dir"
chmod 0700 "$data_dir"
chmod 0700 "$library_dir"
install -m 0755 "$project_dir/target/release/zuradio" "$install_root/zuradio"
install -m 0755 "$project_dir/target/release/zuradio" "$binary_dir/zuradio"
install -m 0755 "$project_dir/packaging/linux/zuradio-launch" "$binary_dir/zuradio-launch"
install -m 0755 "$project_dir/packaging/linux/zuradio-desktop-launch" "$binary_dir/zuradio-desktop-launch"
install -m 0644 "$project_dir/packaging/linux/zuradio.service" "$service_dir/zuradio.service"
install -m 0644 "$project_dir/apps/zuradio-desktop/src-tauri/icons/icon.png" "$icon_dir/zuradio.png"
if [ -f "$legacy_icon" ]; then
  rm -f -- "$legacy_icon"
fi
mkdir -p "$install_root/web"
find "$install_root/web" -type f -delete
find "$install_root/web" -depth -mindepth 1 -type d -empty -delete
cp -R "$project_dir/web/dist/." "$install_root/web/"

launcher_path="$binary_dir/zuradio-desktop-launch"
sed "s|@DESKTOP_LAUNCHER@|$launcher_path|g" "$project_dir/packaging/linux/zuradio-desktop.desktop" > "$desktop_dir/zuradio.desktop"
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

if [ -n "$music_dir" ] && [ -d "$music_dir" ]; then
  "$binary_dir/zuradio" scan "$music_dir" >/dev/null
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$desktop_dir" || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$icon_theme_dir" || true
printf 'Zuradio installed. Launch it from the application menu or run: %s\n' "$binary_dir/zuradio-desktop-launch"
