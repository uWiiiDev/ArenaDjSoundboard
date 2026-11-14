#!/usr/bin/env bash
# Baut ein installationsfertiges Debian/Ubuntu-Paket (.deb) für Arena DJ Soundboard
set -euo pipefail

cd "$(dirname "$0")"

PKG_NAME="arena-dj-soundboard"
PKG_VERSION="${1:-1.0.0}"
ARCH="all"

DIST_DIR="$(pwd)/dist"
STAGE_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGE_DIR"' EXIT

echo "📦 Baue ${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb ..."

# 1. Verzeichnisstruktur anlegen
mkdir -p \
  "$STAGE_DIR/DEBIAN" \
  "$STAGE_DIR/usr/bin" \
  "$STAGE_DIR/usr/share/$PKG_NAME/static" \
  "$STAGE_DIR/usr/share/applications" \
  "$STAGE_DIR/usr/share/pixmaps" \
  "$STAGE_DIR/usr/share/icons/hicolor/scalable/apps" \
  "$STAGE_DIR/usr/lib/systemd/user"

# 2. Programmdateien kopieren (ohne data/, ohne MP3s!)
cp server.py server_audio.py qr_svg.py README.md "$STAGE_DIR/usr/share/$PKG_NAME/"
cp -r static/* "$STAGE_DIR/usr/share/$PKG_NAME/static/"

# 3. Aktuellen Git-Versionsstand als BUILD_INFO.json einbetten (für den integrierten GitHub-Updater)
python3 - "$PKG_VERSION" "$STAGE_DIR/usr/share/$PKG_NAME/BUILD_INFO.json" <<'EOF'
import json, subprocess, sys
from pathlib import Path

version = sys.argv[1]
dest = Path(sys.argv[2])
info = {
    "version": version,
    "branch": "main",
    "commit": "",
    "short": version,
    "subject": f"Arena DJ Soundboard v{version}",
    "date": "",
}
try:
    out = subprocess.check_output(
        ["git", "log", "-1", "--format=%H|%h|%s|%ci", "HEAD"],
        text=True,
        stderr=subprocess.DEVNULL,
    ).strip()
    if "|" in out:
        full_h, short_h, subj, dt = out.split("|", 3)
        info.update({"commit": full_h, "short": short_h, "subject": subj, "date": dt[:16]})
except Exception:
    pass

dest.write_text(json.dumps(info, indent=2), encoding="utf-8")
EOF

# 4. Launcher, Desktop-Menüeintrag & optionalen systemd-User-Service installieren
install -m 0755 packaging/arena-dj "$STAGE_DIR/usr/bin/arena-dj"
install -m 0644 packaging/arena-dj-soundboard.desktop "$STAGE_DIR/usr/share/applications/$PKG_NAME.desktop"
install -m 0644 packaging/arena-dj-soundboard.service "$STAGE_DIR/usr/lib/systemd/user/$PKG_NAME.service"

# 5. App-Icons in allen gängigen Linux-Größen erzeugen (SVG + 48/64/128/256/512 PNG + Pixmap)
install -m 0644 static/icon.svg "$STAGE_DIR/usr/share/icons/hicolor/scalable/apps/$PKG_NAME.svg"

python3 - "$STAGE_DIR" "$PKG_NAME" <<'EOF'
import sys
from pathlib import Path
from PIL import Image

stage = Path(sys.argv[1])
pkg = sys.argv[2]
src = Image.open("static/icon-512.png").convert("RGBA")

for sz in (48, 64, 128, 256, 512):
    out_dir = stage / "usr" / "share" / "icons" / "hicolor" / f"{sz}x{sz}" / "apps"
    out_dir.mkdir(parents=True, exist_ok=True)
    resized = src if sz == 512 else src.resize((sz, sz), Image.Resampling.LANCZOS)
    resized.save(out_dir / f"{pkg}.png", "PNG")

src.resize((128, 128), Image.Resampling.LANCZOS).save(
    stage / "usr" / "share" / "pixmaps" / f"{pkg}.png", "PNG"
)
EOF

# 6. Installierte Größe in KiB berechnen
INSTALLED_SIZE="$(du -sk "$STAGE_DIR/usr" | awk '{print $1}')"

# 7. DEBIAN/control, postinst & postrm schreiben
cat >"$STAGE_DIR/DEBIAN/control" <<EOF
Package: ${PKG_NAME}
Version: ${PKG_VERSION}
Section: sound
Priority: optional
Architecture: ${ARCH}
Installed-Size: ${INSTALLED_SIZE}
Depends: python3 (>= 3.10), python3-numpy, ffmpeg, xdg-utils
Recommends: pipewire-bin | alsa-utils, python3-venv, python3-pip
Maintainer: uWiiiDev <https://github.com/uWiiiDev/ArenaDjSoundboard>
Homepage: https://github.com/uWiiiDev/ArenaDjSoundboard
Description: Live Competition DJ Soundboard & Dual-Deck Audio Mixer
 Web-based live DJ soundboard purpose-built for sports competitions, stadium
 announcements, and live events. Features numbered waveform cue points,
 dual-deck equal-power crossfades, studio master fader, talkover ducking,
 reload-proof PipeWire/ALSA PA output, QR Wi-Fi remote control for iPad/phone,
 and multilingual UI (German, English, French).
EOF

cat >"$STAGE_DIR/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/postinst"

cat >"$STAGE_DIR/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
exit 0
EOF
chmod 0755 "$STAGE_DIR/DEBIAN/postrm"

# 8. .deb-Paket mit korrekten Root-Rechten bauen (ohne sudo!)
mkdir -p "$DIST_DIR"
OUT_DEB="$DIST_DIR/${PKG_NAME}_${PKG_VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group --build "$STAGE_DIR" "$OUT_DEB" >/dev/null

echo "✅ Erfolgreich erstellt: $OUT_DEB"
echo "👉 Installation mit:     sudo apt install $OUT_DEB"
