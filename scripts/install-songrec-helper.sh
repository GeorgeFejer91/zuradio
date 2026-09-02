#!/bin/sh
set -eu

# SongRec remains a separately licensed GPL executable. Zuradio invokes its
# bounded JSON CLI across a process boundary and does not link SongRec code into
# the MIT-licensed daemon. Pin both the official package and its digest.
songrec_version=0.7.5
songrec_source_revision=50b72aab457718fd0b2a814aa002149cea37453a
songrec_url=https://ppa.launchpadcontent.net/marin-m/songrec/ubuntu/pool/main/s/songrec/songrec_0.7.5stonking_amd64.deb
songrec_sha256=39d8c8449015ebd4d2aa46905737a1d0c75fb92721711899460d7c6bdef076bd

install_root=${ZURADIO_INSTALL_ROOT:-"$HOME/.local/lib/zuradio"}
helper_dir="$install_root/songrec"
helper="$helper_dir/songrec"

if [ -x "$helper" ] && "$helper" --version 2>/dev/null | grep -Fqx "songrec $songrec_version"; then
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) ;;
  *)
    printf 'Zuradio currently bundles its verified SongRec helper only for x86-64 Linux.\n' >&2
    exit 1
    ;;
esac

for command_name in curl dpkg-deb ldd sha256sum; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    printf 'Cannot install the Zuradio SongRec helper: %s is unavailable.\n' "$command_name" >&2
    exit 1
  fi
done

staging_dir=$(mktemp -d "${TMPDIR:-/tmp}/zuradio-songrec.XXXXXX")
cleanup() {
  if [ -n "${staging_dir:-}" ] && [ -d "$staging_dir" ]; then
    rm -r -- "$staging_dir"
  fi
}
trap cleanup EXIT HUP INT TERM

package="$staging_dir/songrec.deb"
package_root="$staging_dir/package"
curl --fail --silent --show-error --location --output "$package" "$songrec_url"
actual_sha256=$(sha256sum "$package" | awk '{print $1}')
if [ "$actual_sha256" != "$songrec_sha256" ]; then
  printf 'Refusing the SongRec helper because its package digest is not the pinned value.\n' >&2
  exit 1
fi

dpkg-deb --extract "$package" "$package_root"
candidate="$package_root/usr/bin/songrec"
copyright="$package_root/usr/share/doc/songrec/copyright"
if [ ! -x "$candidate" ] || [ ! -f "$copyright" ]; then
  printf 'The verified SongRec package did not contain its executable and copyright notice.\n' >&2
  exit 1
fi
if ldd "$candidate" 2>/dev/null | grep -F 'not found' >/dev/null; then
  printf 'The bundled SongRec helper needs a runtime library that is not installed on this computer.\n' >&2
  exit 1
fi
if ! "$candidate" --version 2>/dev/null | grep -Fqx "songrec $songrec_version"; then
  printf 'The bundled SongRec helper did not report the pinned version.\n' >&2
  exit 1
fi

mkdir -p "$helper_dir"
install -m 0755 "$candidate" "$helper"
install -m 0644 "$copyright" "$helper_dir/COPYRIGHT"
{
  printf 'SongRec %s\n' "$songrec_version"
  printf 'Source: https://github.com/marin-m/SongRec/tree/%s\n' "$songrec_source_revision"
  printf 'License: GPL-3.0-or-later (see COPYRIGHT and https://www.gnu.org/licenses/gpl-3.0.html)\n'
} > "$helper_dir/SOURCE"

printf 'Installed the verified Rust SongRec %s helper for automatic acoustic metadata.\n' "$songrec_version"
