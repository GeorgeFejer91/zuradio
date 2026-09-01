#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
appimage="$project_dir/target/release/bundle/appimage/Zuradio_0.1.0_amd64.AppImage"
install_root="$HOME/.local/lib/zuradio"
binary_dir="$HOME/.local/bin"
desktop_dir="$HOME/.local/share/applications"

if [ ! -f "$appimage" ]; then
  printf 'Build the Tauri AppImage before installing: %s\n' "$appimage" >&2
  exit 1
fi

mkdir -p "$install_root" "$binary_dir" "$desktop_dir"
install -m 0755 "$appimage" "$install_root/Zuradio.AppImage"
install -m 0755 "$project_dir/packaging/linux/zuradio-desktop-launch" "$binary_dir/zuradio-desktop-launch"
sed "s|@DESKTOP_LAUNCHER@|$binary_dir/zuradio-desktop-launch|g" \
  "$project_dir/packaging/linux/zuradio-desktop.desktop" > "$desktop_dir/zuradio.desktop"
chmod 0644 "$desktop_dir/zuradio.desktop"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$desktop_dir" || true
printf 'Zuradio desktop installed. Launch it from the application menu or run: %s\n' "$binary_dir/zuradio-desktop-launch"
