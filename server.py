#!/usr/bin/env python3
"""
Arena DJ Soundboard - Zentraler Wettkampf-Musik-Server
Speichert MP3s, Kategorien, Highlights (Cue-Points) und Einstellungen dauerhaft in SQLite.
Unterstützt HTTP Range-Requests (206 Partial Content) für verzögerungsfreies Springen
zu Highlights auf iPad (iOS Safari), Android und Desktop-Browsern.
"""

from email.parser import BytesParser
from email.policy import default as default_email_policy
import hashlib
import hmac
from http.cookies import SimpleCookie
import io
import json
import math
import mimetypes
import os
import re
import secrets
import shutil
import socket
import sqlite3
import struct
import subprocess
import sys
import tarfile
import threading
import time
import urllib.parse
import urllib.request
import uuid
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from qr_svg import generate_qr_svg
from server_audio import ServerAudioEngine

SESSION_COOKIE_NAME = "arena_dj_session"
SESSION_MAX_AGE = 30 * 24 * 3600  # 30 Tage gültig auf dem iPad/Handy
_LOGIN_LOCK = threading.Lock()
_FAILED_LOGINS: dict[str, list[float]] = {}  # IP -> Zeitstempel fehlgeschlagener Logins
INTERNAL_SECRET_KEYS = {
    "cookie_secret",
    "auth_password_hash",
    "auth_password_salt",
}


def hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000
    ).hex()


def compute_session_signature(settings: dict[str, str]) -> str:
    secret = settings.get("cookie_secret", "fallback-secret")
    token = settings.get("access_token", "")
    pw_hash = settings.get("auth_password_hash", "")
    payload = f"arena_dj_v1:{token}:{pw_hash}".encode("utf-8")
    return hmac.new(secret.encode("utf-8"), payload, hashlib.sha256).hexdigest()


def check_rate_limit(ip: str) -> tuple[bool, int]:
    """Erlaubt max. 5 Fehlversuche innerhalb von 60 Sekunden pro IP."""
    now = time.time()
    with _LOGIN_LOCK:
        attempts = [t for t in _FAILED_LOGINS.get(ip, []) if now - t < 60]
        _FAILED_LOGINS[ip] = attempts
        if len(attempts) >= 5:
            retry_after = max(1, int(60 - (now - attempts[0])))
            return False, retry_after
        return True, 0


def record_failed_login(ip: str):
    now = time.time()
    with _LOGIN_LOCK:
        attempts = [t for t in _FAILED_LOGINS.get(ip, []) if now - t < 60]
        attempts.append(now)
        _FAILED_LOGINS[ip] = attempts


def clear_failed_logins(ip: str):
    with _LOGIN_LOCK:
        _FAILED_LOGINS.pop(ip, None)

GITHUB_REPO = "uWiiiDev/ArenaDjSoundboard"
BASE_DIR = Path(__file__).resolve().parent


def _resolve_data_dir() -> Path:
    """
    Nutzt im Entwicklungs-/Git-Ordner weiterhin ./data,
    und bei einer System-/DEB-Installation (/usr/share/...) automatisch
    ~/.local/share/arena-dj-soundboard, damit Lieder & SQLite-Datenbank
    dauerhaft im Benutzerordner gespeichert bleiben.
    """
    env_dir = os.environ.get("ARENA_DJ_DATA_DIR", "").strip()
    if env_dir:
        return Path(env_dir).expanduser().resolve()

    if (
        str(BASE_DIR).startswith(("/usr/", "/opt/"))
        or "app_override" in BASE_DIR.parts
        or not os.access(BASE_DIR, os.W_OK)
    ):
        xdg_data = os.environ.get("XDG_DATA_HOME", "").strip()
        base_user = Path(xdg_data).expanduser() if xdg_data else (Path.home() / ".local" / "share")
        return (base_user / "arena-dj-soundboard").resolve()

    return BASE_DIR / "data"


DATA_DIR = _resolve_data_dir()
UPLOADS_DIR = DATA_DIR / "uploads"
DB_PATH = DATA_DIR / "arena_dj.db"
STATIC_DIR = BASE_DIR / "static"

UPLOADS_DIR.mkdir(parents=True, exist_ok=True)
if not STATIC_DIR.exists() and os.access(BASE_DIR, os.W_OK):
    STATIC_DIR.mkdir(parents=True, exist_ok=True)


def get_local_ip() -> str:
    """Ermittelt die lokale WLAN/LAN-IP-Adresse für den Zugriff vom iPad/Handy."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def _run_git(args: list[str], timeout: int = 12) -> subprocess.CompletedProcess:
    env = {**os.environ, "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
    return subprocess.run(
        ["git", *args],
        cwd=str(BASE_DIR),
        capture_output=True,
        text=True,
        timeout=timeout,
        env=env,
    )


def get_local_git_info() -> dict:
    """Liest schnell und rein lokal den aktuell installierten Git- oder Paket-Stand aus."""
    if (BASE_DIR / ".git").exists() and shutil.which("git"):
        try:
            log_proc = _run_git(["log", "-1", "--format=%H|%h|%s|%ci", "HEAD"], timeout=4)
            branch_proc = _run_git(["rev-parse", "--abbrev-ref", "HEAD"], timeout=4)
            branch = (branch_proc.stdout.strip() or "main") if branch_proc.returncode == 0 else "main"
            if branch == "HEAD":
                branch = "main"
            if log_proc.returncode == 0 and "|" in log_proc.stdout:
                full_hash, short_hash, subject, date_str = log_proc.stdout.strip().split("|", 3)
                return {
                    "git_available": True,
                    "install_mode": "git",
                    "branch": branch,
                    "local_commit": full_hash,
                    "local_short": short_hash,
                    "local_subject": subject,
                    "local_date": date_str[:16],
                }
        except Exception:
            pass

    build_info_file = BASE_DIR / "BUILD_INFO.json"
    if build_info_file.is_file():
        try:
            info = json.loads(build_info_file.read_text(encoding="utf-8"))
            return {
                "git_available": True,
                "install_mode": "deb",
                "branch": info.get("branch", "main"),
                "local_commit": info.get("commit", ""),
                "local_short": info.get("short", info.get("version", "deb")),
                "local_subject": info.get("subject", f"Arena DJ {info.get('version', '1.0.0')}"),
                "local_date": info.get("date", ""),
            }
        except Exception:
            pass

    return {"git_available": False}


def _github_api_get_json(url: str, timeout: int = 10) -> dict | list:
    req = urllib.request.Request(
        url,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "ArenaDjSoundboard-Updater/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def check_github_updates() -> dict:
    """Prüft online auf GitHub (per Git oder HTTPS-API bei .deb-Installation), ob Updates vorliegen."""
    local_info = get_local_git_info()
    if not local_info.get("git_available"):
        return {
            "ok": False,
            "git_available": False,
            "error": "Keine Versionsinformationen gefunden.",
        }

    branch = local_info.get("branch", "main")

    # Modus A: .deb-Paketinstallation ohne .git -> Prüfung direkt über die GitHub HTTPS-API
    if local_info.get("install_mode") == "deb":
        try:
            commits_data = _github_api_get_json(
                f"https://api.github.com/repos/{GITHUB_REPO}/commits?sha={branch}&per_page=8",
                timeout=10,
            )
            if not isinstance(commits_data, list) or not commits_data:
                return {**local_info, "ok": False, "error": "Unerwartete Antwort von GitHub."}

            latest = commits_data[0]
            remote_commit = latest.get("sha", "")
            remote_short = remote_commit[:7]
            commit_obj = latest.get("commit") or {}
            remote_subject = (commit_obj.get("message") or "").splitlines()[0]
            remote_date = ((commit_obj.get("committer") or {}).get("date") or "")[:16].replace("T", " ")

            local_commit = local_info.get("local_commit", "")
            if remote_commit == local_commit or (local_commit and remote_commit.startswith(local_commit)):
                return {
                    **local_info,
                    "ok": True,
                    "remote_commit": remote_commit,
                    "remote_short": remote_short,
                    "remote_subject": remote_subject,
                    "remote_date": remote_date,
                    "commits_behind": 0,
                    "commits_ahead": 0,
                    "update_available": False,
                    "changelog": [],
                }

            changelog: list[str] = []
            commits_behind = 0
            for item in commits_data:
                sha = item.get("sha", "")
                if local_commit and (sha == local_commit or sha.startswith(local_commit)):
                    break
                commits_behind += 1
                msg_first = ((item.get("commit") or {}).get("message") or "").splitlines()[0]
                if len(changelog) < 6:
                    changelog.append(f"{sha[:7]} – {msg_first}")

            return {
                **local_info,
                "ok": True,
                "remote_commit": remote_commit,
                "remote_short": remote_short,
                "remote_subject": remote_subject,
                "remote_date": remote_date,
                "commits_behind": max(1, commits_behind),
                "commits_ahead": 0,
                "update_available": True,
                "changelog": changelog,
            }
        except Exception:
            return {
                **local_info,
                "ok": False,
                "offline": True,
                "error": "GitHub konnte nicht erreicht werden (bitte Internetverbindung prüfen).",
            }

    # Modus B: Klassisches Git-Repository
    try:
        fetch_proc = _run_git(["fetch", "origin", branch, "--quiet"], timeout=12)
        if fetch_proc.returncode != 0:
            return {
                **local_info,
                "ok": False,
                "offline": True,
                "error": "GitHub konnte nicht erreicht werden (bitte Internetverbindung prüfen).",
            }

        behind_proc = _run_git(["rev-list", "--count", f"HEAD..origin/{branch}"], timeout=5)
        ahead_proc = _run_git(["rev-list", "--count", f"origin/{branch}..HEAD"], timeout=5)
        remote_log = _run_git(["log", "-1", "--format=%H|%h|%s|%ci", f"origin/{branch}"], timeout=5)

        commits_behind = int(behind_proc.stdout.strip() or "0") if behind_proc.returncode == 0 else 0
        commits_ahead = int(ahead_proc.stdout.strip() or "0") if ahead_proc.returncode == 0 else 0

        remote_commit = local_info["local_commit"]
        remote_short = local_info["local_short"]
        remote_subject = local_info["local_subject"]
        remote_date = local_info["local_date"]
        if remote_log.returncode == 0 and "|" in remote_log.stdout:
            rc, rs, rsub, rdate = remote_log.stdout.strip().split("|", 3)
            remote_commit, remote_short, remote_subject, remote_date = rc, rs, rsub, rdate[:16]

        changelog = []
        if commits_behind > 0:
            cl_proc = _run_git(
                ["log", "--format=%h – %s", f"HEAD..origin/{branch}", "-n", "6"],
                timeout=5,
            )
            if cl_proc.returncode == 0:
                changelog = [line.strip() for line in cl_proc.stdout.splitlines() if line.strip()]

        return {
            **local_info,
            "ok": True,
            "remote_commit": remote_commit,
            "remote_short": remote_short,
            "remote_subject": remote_subject,
            "remote_date": remote_date,
            "commits_behind": commits_behind,
            "commits_ahead": commits_ahead,
            "update_available": commits_behind > 0,
            "changelog": changelog,
        }
    except subprocess.TimeoutExpired:
        return {
            **local_info,
            "ok": False,
            "offline": True,
            "error": "Zeitüberschreitung bei der Verbindung zu GitHub (kein Internet in der Halle?).",
        }
    except Exception as e:
        return {
            **local_info,
            "ok": False,
            "error": f"Fehler bei der Update-Prüfung: {e}",
        }


def perform_github_update() -> dict:
    """Lädt Änderungen von GitHub herunter, ohne data/ (MP3s & Datenbank) anzutasten."""
    local_info = get_local_git_info()
    if not local_info.get("git_available"):
        return {
            "ok": False,
            "error": "Keine Versionsinformationen gefunden.",
        }

    branch = local_info.get("branch", "main")

    # Modus A: .deb-Installation -> Update im Benutzerverzeichnis (app_override) ohne Root-Zwang!
    if local_info.get("install_mode") == "deb":
        try:
            check = check_github_updates()
            if not check.get("ok"):
                return {"ok": False, "error": check.get("error", "GitHub nicht erreichbar.")}
            if not check.get("update_available"):
                return {
                    **local_info,
                    "ok": True,
                    "updated": False,
                    "restarting": False,
                    "message": "Bereits auf dem neuesten Stand.",
                }

            tar_url = f"https://codeload.github.com/{GITHUB_REPO}/tar.gz/refs/heads/{branch}"
            req = urllib.request.Request(tar_url, headers={"User-Agent": "ArenaDjSoundboard-Updater/1.0"})
            with urllib.request.urlopen(req, timeout=25) as resp:
                tar_bytes = resp.read()

            override_dir = DATA_DIR / "app_override"
            staging_dir = DATA_DIR / "app_override_staging"
            if staging_dir.exists():
                shutil.rmtree(staging_dir)
            staging_dir.mkdir(parents=True, exist_ok=True)

            with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tf:
                for member in tf.getmembers():
                    parts = Path(member.name).parts
                    if len(parts) <= 1:
                        continue
                    rel_path = Path(*parts[1:])
                    if ".." in rel_path.parts or rel_path.parts[0] == "data":
                        continue
                    dest = staging_dir / rel_path
                    if member.isdir():
                        dest.mkdir(parents=True, exist_ok=True)
                    elif member.isfile():
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        f_obj = tf.extractfile(member)
                        if f_obj:
                            dest.write_bytes(f_obj.read())

            new_build_info = {
                "version": "github-main",
                "branch": branch,
                "commit": check["remote_commit"],
                "short": check["remote_short"],
                "subject": check["remote_subject"],
                "date": check["remote_date"],
                "updated_at": int(time.time()),
            }
            (staging_dir / "BUILD_INFO.json").write_text(
                json.dumps(new_build_info, indent=2), encoding="utf-8"
            )

            if override_dir.exists():
                shutil.rmtree(override_dir)
            staging_dir.rename(override_dir)

            return {
                "ok": True,
                "updated": True,
                "restarting": True,
                "local_short": check["remote_short"],
                "local_subject": check["remote_subject"],
                "local_date": check["remote_date"],
                "exec_script": str(override_dir / "server.py"),
            }
        except Exception as e:
            return {"ok": False, "error": f"Fehler beim Paket-Update: {e}"}

    # Modus B: Klassisches Git-Repository
    try:
        fetch_proc = _run_git(["fetch", "origin", branch, "--quiet"], timeout=15)
        if fetch_proc.returncode != 0:
            return {
                "ok": False,
                "error": "GitHub konnte zum Herunterladen nicht erreicht werden.",
            }

        diff_proc = _run_git(["diff", "--name-only", f"HEAD..origin/{branch}"], timeout=6)
        changed_files = [
            f.strip() for f in (diff_proc.stdout.splitlines() if diff_proc.returncode == 0 else []) if f.strip()
        ]
        if not changed_files:
            return {
                **local_info,
                "ok": True,
                "updated": False,
                "restarting": False,
                "message": "Bereits auf dem neuesten Stand.",
            }

        # Falls getrackte Code-Dateien lokal verändert wurden, sicher stashen (data/ bleibt völlig unberührt!)
        status_proc = _run_git(["status", "--porcelain", "--untracked-files=no"], timeout=6)
        if status_proc.returncode == 0 and status_proc.stdout.strip():
            _run_git(["stash", "push", "-m", "arena-dj-auto-stash-before-update"], timeout=10)

        pull_proc = _run_git(["pull", "--ff-only", "origin", branch], timeout=20)
        if pull_proc.returncode != 0:
            err_detail = (pull_proc.stderr or pull_proc.stdout or "").strip()
            return {
                "ok": False,
                "error": f"Git-Update fehlgeschlagen: {err_detail or 'Fast-Forward nicht möglich.'}",
            }

        new_info = get_local_git_info()
        needs_restart = any(f.endswith(".py") for f in changed_files)
        return {
            **new_info,
            "ok": True,
            "updated": True,
            "restarting": needs_restart,
            "changed_files": changed_files,
        }
    except Exception as e:
        return {
            "ok": False,
            "error": f"Fehler beim Ausführen des Updates: {e}",
        }


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def compute_audio_info_and_peaks(filepath: Path, num_peaks: int = 180) -> tuple[float, list[float]]:
    """
    Nutzt ffmpeg/ffprobe (falls vorhanden), um Dauer und Wellenform-Peaks schnell zu berechnen.
    Falls nicht verfügbar, übernimmt das Frontend per Web Audio API die Berechnung.
    """
    duration = 0.0
    peaks: list[float] = []
    try:
        # 1. Dauer per ffprobe ermitteln
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(filepath),
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if probe.returncode == 0 and probe.stdout.strip():
            duration = round(float(probe.stdout.strip()), 2)

        # 2. Roh-Audio (Mono, 4000 Hz, 16-bit signed PCM) für schnelle Waveform-Peaks lesen
        proc = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-i",
                str(filepath),
                "-ac",
                "1",
                "-ar",
                "2000",
                "-f",
                "s16le",
                "-",
            ],
            capture_output=True,
            timeout=20,
        )
        raw = proc.stdout
        total_samples = len(raw) // 2
        if total_samples > 0:
            samples = struct.unpack(f"<{total_samples}h", raw[: total_samples * 2])
            chunk_size = max(1, total_samples // num_peaks)
            raw_peaks = []
            for i in range(num_peaks):
                start = i * chunk_size
                end = min(total_samples, start + chunk_size)
                if start >= total_samples:
                    raw_peaks.append(0.05)
                else:
                    segment = samples[start:end]
                    max_val = max(abs(x) for x in segment) if segment else 0
                    raw_peaks.append(max_val / 32768.0)
            max_peak = max(raw_peaks) if raw_peaks else 1.0
            if max_peak > 0:
                peaks = [round(max(0.04, p / max_peak), 3) for p in raw_peaks]
            else:
                peaks = [0.1] * num_peaks
    except Exception as e:
        print(f"Hinweis bei Audio-Analyse: {e}")

    return duration, peaks


SPOTDL_VENV_DIR = Path.home() / ".local" / "share" / "arena-dj-soundboard" / "spotdl-venv"
SPOTDL_LOCK = threading.Lock()
SPOTDL_PROC: subprocess.Popen | None = None
SPOTDL_CANCEL_REQUESTED = False
SPOTDL_JOB: dict = {
    "running": False,
    "status": "idle",
    "query": "",
    "category_id": "action",
    "created_category_id": None,
    "created_category_name": None,
    "message": "",
    "completed_count": 0,
    "total_count": 0,
    "imported_tracks": [],
    "errors": [],
    "log_lines": [],
    "updated_at": 0.0,
}


def find_spotdl_binary() -> str | None:
    """Sucht nach einer vorhandenen spotdl-Installation (eigenes Venv, ~/.local/bin oder System-PATH)."""
    candidates = [
        SPOTDL_VENV_DIR / "bin" / "spotdl",
        Path.home() / ".local" / "bin" / "spotdl",
    ]
    for c in candidates:
        if c.is_file() and os.access(c, os.X_OK):
            return str(c)
    which_bin = shutil.which("spotdl")
    if which_bin:
        return which_bin
    return None


def _append_spotdl_log(line: str, message: str | None = None):
    clean = line.strip()
    with SPOTDL_LOCK:
        if clean:
            SPOTDL_JOB["log_lines"].append(clean)
            if len(SPOTDL_JOB["log_lines"]) > 40:
                SPOTDL_JOB["log_lines"] = SPOTDL_JOB["log_lines"][-40:]
        if message is not None:
            SPOTDL_JOB["message"] = message
        SPOTDL_JOB["updated_at"] = time.time()


def ensure_spotdl_binary() -> str:
    """Stellt sicher, dass spotdl installiert ist; richtet es bei Bedarf automatisch in einem Venv ein."""
    existing = find_spotdl_binary()
    if existing:
        return existing

    _append_spotdl_log(
        "spotdl wird erstmalig in ~/.local/share/arena-dj-soundboard/spotdl-venv eingerichtet...",
        "Installiere spotDL (einmalige Einrichtung, dauert ca. 30–60 Sek.)...",
    )
    SPOTDL_VENV_DIR.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [sys.executable, "-m", "venv", str(SPOTDL_VENV_DIR)],
        check=True,
        capture_output=True,
        text=True,
        timeout=120,
    )
    pip_bin = SPOTDL_VENV_DIR / "bin" / "pip"
    subprocess.run(
        [str(pip_bin), "install", "--upgrade", "pip", "spotdl"],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    spotdl_bin = SPOTDL_VENV_DIR / "bin" / "spotdl"
    if not spotdl_bin.is_file():
        raise RuntimeError("spotdl konnte nicht automatisch installiert werden.")
    return str(spotdl_bin)


def extract_mp3_metadata(filepath: Path) -> tuple[str, str]:
    """Liest Titel und Interpret per ffprobe aus den ID3-Tags oder fällt auf den Dateinamen zurück."""
    title = ""
    artist = ""
    try:
        probe = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format_tags=title,artist",
                "-of",
                "json",
                str(filepath),
            ],
            capture_output=True,
            text=True,
            timeout=8,
        )
        if probe.returncode == 0 and probe.stdout.strip():
            info = json.loads(probe.stdout)
            tags = (info.get("format") or {}).get("tags") or {}
            # Case-insensitive Tag-Suche
            for k, v in tags.items():
                kl = k.lower()
                if kl == "title" and v:
                    title = str(v).strip()
                elif kl == "artist" and v:
                    artist = str(v).strip()
    except Exception:
        pass

    if not title:
        stem = filepath.stem.replace("_", " ").strip()
        if " - " in stem:
            parts = stem.split(" - ", 1)
            artist = artist or parts[0].strip()
            title = parts[1].strip()
        else:
            title = stem
    return title or "Unbekanntes Lied", artist


def ensure_playlist_category(playlist_name: str) -> str:
    """Legt eine neue Kategorie für die importierte Spotify-Playlist an (oder gibt die vorhandene zurück)."""
    clean_name = playlist_name.strip()[:48] or "Spotify Playlist"
    cat_id = re.sub(r"[^a-z0-9]+", "-", clean_name.lower()).strip("-") or f"spotify-{uuid.uuid4().hex[:6]}"
    conn = get_db()
    existing = conn.execute("SELECT id FROM categories WHERE id = ? OR lower(name) = lower(?)", (cat_id, clean_name)).fetchone()
    if existing:
        real_id = existing["id"]
        conn.close()
        return real_id
    max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM categories").fetchone()[0]
    conn.execute(
        "INSERT INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)",
        (cat_id, clean_name, "🟢", max_order + 1),
    )
    conn.commit()
    conn.close()
    return cat_id


def import_spotdl_mp3_file(mp3_path: Path, category_id: str, base_color: str, idx: int) -> dict | None:
    """Übernimmt eine fertig heruntergeladene MP3-Datei in das Soundboard inkl. Wellenform-Analyse."""
    if not mp3_path.is_file() or mp3_path.stat().st_size < 8192:
        return None

    title, artist = extract_mp3_metadata(mp3_path)
    safe_stem = re.sub(r"[^a-zA-Z0-9_\-\.äöüÄÖÜß ]", "_", mp3_path.stem).strip() or "spotify_track"
    unique_filename = f"{int(time.time())}_{uuid.uuid4().hex[:6]}_{safe_stem}.mp3"
    dest_path = UPLOADS_DIR / unique_filename

    shutil.move(str(mp3_path), str(dest_path))
    duration, peaks = compute_audio_info_and_peaks(dest_path)

    palette = [
        "#22c55e",
        "#f97316",
        "#38bdf8",
        "#a855f7",
        "#eab308",
        "#ec4899",
        "#14b8a6",
        "#ef4444",
    ]
    track_color = base_color if idx == 0 and base_color else palette[idx % len(palette)]

    conn = get_db()
    max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM tracks").fetchone()[0]
    cur = conn.execute(
        """
        INSERT INTO tracks (title, artist, filename, category_id, duration, volume, color, peaks_json, sort_order)
        VALUES (?, ?, ?, ?, ?, 1.0, ?, ?, ?)
        """,
        (
            title,
            artist,
            unique_filename,
            category_id,
            duration,
            track_color,
            json.dumps(peaks),
            max_order + 1,
        ),
    )
    track_id = cur.lastrowid
    conn.commit()
    conn.close()

    if PLAYER_ENGINE:
        tracks, _ = load_tracks_and_settings()
        PLAYER_ENGINE.refresh_track_metadata(tracks)

    return {
        "id": track_id,
        "title": title,
        "artist": artist,
        "duration": duration,
        "category_id": category_id,
    }


def normalize_spotify_queries(raw_query: str) -> list[str]:
    """Bereinigt Spotify-Links (z. B. /intl-de/) und unterstützt mehrere Zeilen."""
    queries: list[str] = []
    for line in raw_query.splitlines():
        q = line.strip()
        if not q:
            continue
        q = re.sub(r"https?://open\.spotify\.com/intl-[a-zA-Z0-9_-]+/", "https://open.spotify.com/", q)
        queries.append(q)
    return queries


def start_spotdl_download_job(raw_query: str, category_id: str, fallback_category_id: str, color: str) -> dict:
    global SPOTDL_PROC, SPOTDL_CANCEL_REQUESTED
    queries = normalize_spotify_queries(raw_query)
    if not queries:
        return {"ok": False, "error": "Bitte einen Spotify-Link (Playlist / Song / Album) oder Suchbegriff eingeben."}

    with SPOTDL_LOCK:
        if SPOTDL_JOB["running"]:
            return {"ok": False, "error": "Es läuft bereits ein Spotify-Download im Hintergrund."}

        target_cat = fallback_category_id if category_id == "__playlist__" else (category_id or "action")
        SPOTDL_CANCEL_REQUESTED = False
        SPOTDL_JOB.update(
            {
                "running": True,
                "status": "running",
                "query": queries[0],
                "category_id": target_cat,
                "created_category_id": None,
                "created_category_name": None,
                "message": "Verbinde mit Spotify & analysiere Playlist/Song...",
                "completed_count": 0,
                "total_count": 0,
                "imported_tracks": [],
                "errors": [],
                "log_lines": [],
                "updated_at": time.time(),
            }
        )

    def _worker():
        global SPOTDL_PROC, SPOTDL_CANCEL_REQUESTED
        staging_dir = DATA_DIR / "spotdl_staging" / f"job_{int(time.time())}_{uuid.uuid4().hex[:6]}"
        staging_dir.mkdir(parents=True, exist_ok=True)
        active_cat = fallback_category_id if category_id == "__playlist__" else (category_id or "action")
        imported_files: set[str] = set()

        def _scan_and_import_ready_mp3s(only_stem: str | None = None):
            nonlocal active_cat
            for mp3_file in sorted(staging_dir.glob("*.mp3")):
                if mp3_file.name in imported_files:
                    continue
                if only_stem and mp3_file.stem.lower() != only_stem.lower():
                    continue
                try:
                    if mp3_file.stat().st_size < 8192:
                        continue
                except OSError:
                    continue
                imported_files.add(mp3_file.name)
                with SPOTDL_LOCK:
                    idx = len(SPOTDL_JOB["imported_tracks"])
                track_info = import_spotdl_mp3_file(mp3_file, active_cat, color, idx)
                if track_info:
                    with SPOTDL_LOCK:
                        SPOTDL_JOB["imported_tracks"].append(track_info)
                        SPOTDL_JOB["completed_count"] = len(SPOTDL_JOB["imported_tracks"])
                        total = SPOTDL_JOB["total_count"]
                        done = SPOTDL_JOB["completed_count"]
                        progress_prefix = f"({done}/{total}) " if total > 0 else f"({done}) "
                        SPOTDL_JOB["message"] = f"{progress_prefix}Importiert: {track_info['artist']} - {track_info['title']}".strip(" -")
                        SPOTDL_JOB["updated_at"] = time.time()

        try:
            spotdl_bin = ensure_spotdl_binary()
            output_tmpl = str(staging_dir / "{artist} - {title}.{output-ext}")
            cmd = [
                spotdl_bin,
                "download",
                *queries,
                "--output",
                output_tmpl,
                "--format",
                "mp3",
                "--threads",
                "2",
                "--simple-tui",
            ]
            env = os.environ.copy()
            env["PYTHONUNBUFFERED"] = "1"

            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1,
                env=env,
            )
            with SPOTDL_LOCK:
                SPOTDL_PROC = proc

            assert proc.stdout is not None
            for raw_line in proc.stdout:
                line = raw_line.strip()
                if not line:
                    continue

                # Playlist-/Album-Erkennung: "Found 15 songs in Warm-Up 2026 (Playlist)"
                m_found = re.search(r"Found\s+(\d+)\s+songs\s+in\s+(.+?)\s+\((Playlist|Album|Artist)\)", line, re.IGNORECASE)
                if m_found:
                    count_val = int(m_found.group(1))
                    list_name = m_found.group(2).strip()
                    if category_id == "__playlist__" and list_name:
                        active_cat = ensure_playlist_category(list_name)
                        with SPOTDL_LOCK:
                            SPOTDL_JOB["category_id"] = active_cat
                            SPOTDL_JOB["created_category_id"] = active_cat
                            SPOTDL_JOB["created_category_name"] = list_name
                    with SPOTDL_LOCK:
                        SPOTDL_JOB["total_count"] += count_val
                    _append_spotdl_log(line, f"Playlist erkannt: „{list_name}“ ({count_val} Lieder) – starte Download...")
                    continue

                # Fortschrittszähler: "3/15 complete"
                m_comp = re.search(r"^(\d+)/(\d+)\s+complete", line, re.IGNORECASE)
                if m_comp:
                    total_val = int(m_comp.group(2))
                    with SPOTDL_LOCK:
                        if total_val > SPOTDL_JOB["total_count"]:
                            SPOTDL_JOB["total_count"] = total_val
                    _append_spotdl_log(line)
                    _scan_and_import_ready_mp3s()
                    continue

                # Fertigmeldung eines einzelnen Songs: "<Song>: Done" oder 'Downloaded "<Song>":'
                m_done = re.match(r"^(.+?):\s+Done$", line)
                if m_done:
                    song_stem = m_done.group(1).strip()
                    _append_spotdl_log(line)
                    time.sleep(0.15)
                    _scan_and_import_ready_mp3s(only_stem=song_stem)
                    _scan_and_import_ready_mp3s()
                    continue

                m_dl = re.match(r'^Downloaded\s+"(.+?)":', line)
                if m_dl:
                    song_stem = m_dl.group(1).strip()
                    _append_spotdl_log(line)
                    time.sleep(0.15)
                    _scan_and_import_ready_mp3s(only_stem=song_stem)
                    _scan_and_import_ready_mp3s()
                    continue

                # Aktiver Schritt eines Lieds: "<Song>: Downloading" / "Searching for song" / "Embedding metadata"
                m_step = re.match(r"^(.+?):\s+(Searching for song|Getting audio meta|Downloading|Embedding metadata|Converting)$", line)
                if m_step:
                    song_label = m_step.group(1).strip()
                    step_en = m_step.group(2)
                    step_de = {
                        "Searching for song": "Suche Audio-Stream",
                        "Getting audio meta": "Lade Metadaten",
                        "Downloading": "Lade MP3 herunter",
                        "Converting": "Konvertiere MP3",
                        "Embedding metadata": "Schreibe ID3-Tags",
                    }.get(step_en, step_en)
                    with SPOTDL_LOCK:
                        done = SPOTDL_JOB["completed_count"]
                        total = SPOTDL_JOB["total_count"]
                        prefix = f"[{done}/{total}] " if total > 0 else ""
                    _append_spotdl_log(line, f"{prefix}{step_de}: {song_label}...")
                    continue

                if "error" in line.lower() or "exception" in line.lower():
                    with SPOTDL_LOCK:
                        SPOTDL_JOB["errors"].append(line)

                _append_spotdl_log(line)

            proc.wait()
            with SPOTDL_LOCK:
                SPOTDL_PROC = None

            # Alle noch im Staging-Ordner liegenden fertigen MP3s importieren
            _scan_and_import_ready_mp3s()

            with SPOTDL_LOCK:
                done_count = SPOTDL_JOB["completed_count"]
                if SPOTDL_CANCEL_REQUESTED:
                    SPOTDL_JOB["running"] = False
                    SPOTDL_JOB["status"] = "cancelled"
                    SPOTDL_JOB["message"] = f"Download abgebrochen ({done_count} Lieder wurden bereits ins Soundboard übernommen)."
                elif done_count > 0:
                    SPOTDL_JOB["running"] = False
                    SPOTDL_JOB["status"] = "done"
                    SPOTDL_JOB["message"] = f"Fertig! {done_count} {'Lied wurde' if done_count == 1 else 'Lieder wurden'} erfolgreich als MP3 importiert."
                else:
                    SPOTDL_JOB["running"] = False
                    SPOTDL_JOB["status"] = "error"
                    last_err = SPOTDL_JOB["errors"][-1] if SPOTDL_JOB["errors"] else (SPOTDL_JOB["log_lines"][-1] if SPOTDL_JOB["log_lines"] else "Keine Lieder gefunden.")
                    SPOTDL_JOB["message"] = f"Keine MP3s heruntergeladen ({last_err})"
                SPOTDL_JOB["updated_at"] = time.time()

        except Exception as e:
            with SPOTDL_LOCK:
                SPOTDL_PROC = None
                SPOTDL_JOB["running"] = False
                SPOTDL_JOB["status"] = "error"
                SPOTDL_JOB["message"] = f"Fehler beim Spotify-Download: {e}"
                SPOTDL_JOB["errors"].append(str(e))
                SPOTDL_JOB["updated_at"] = time.time()
        finally:
            shutil.rmtree(staging_dir, ignore_errors=True)

    threading.Thread(target=_worker, daemon=True).start()
    return {"ok": True, "job": get_spotdl_job_status()}


def cancel_spotdl_download_job() -> dict:
    global SPOTDL_PROC, SPOTDL_CANCEL_REQUESTED
    with SPOTDL_LOCK:
        SPOTDL_CANCEL_REQUESTED = True
        proc = SPOTDL_PROC
    if proc and proc.poll() is None:
        try:
            proc.terminate()
        except Exception:
            pass
    return {"ok": True, "job": get_spotdl_job_status()}


def get_spotdl_job_status() -> dict:
    with SPOTDL_LOCK:
        return {
            "running": SPOTDL_JOB["running"],
            "status": SPOTDL_JOB["status"],
            "query": SPOTDL_JOB["query"],
            "category_id": SPOTDL_JOB["category_id"],
            "created_category_id": SPOTDL_JOB["created_category_id"],
            "created_category_name": SPOTDL_JOB["created_category_name"],
            "message": SPOTDL_JOB["message"],
            "completed_count": SPOTDL_JOB["completed_count"],
            "total_count": SPOTDL_JOB["total_count"],
            "imported_tracks": list(SPOTDL_JOB["imported_tracks"]),
            "errors": list(SPOTDL_JOB["errors"][-5:]),
            "log_lines": list(SPOTDL_JOB["log_lines"][-15:]),
            "updated_at": SPOTDL_JOB["updated_at"],
            "spotdl_installed": find_spotdl_binary() is not None,
        }


def generate_demo_audio_files():
    """
    Erzeugt beim allerersten Start 3 Demo-MP3s mit unterschiedlichen Abschnitten,
    damit das Soundboard und die Wellenform sofort getestet werden können.
    """
    demos = [
        {
            "filename": "demo_arena_hype.mp3",
            "title": "Arena Hype Anthem (Demo)",
            "artist": "Stadium Beats",
            "category": "action",
            "color": "#f97316",
            "filter": (
                "aevalsrc='"
                "if(lt(t,6), 0.25*sin(2*PI*110*t)*exp(-4*mod(t,0.5)), "
                "if(lt(t,18), 0.45*sin(2*PI*55*t)*exp(-3*mod(t,0.4)) + 0.3*sin(2*PI*440*t*(1+0.5*mod(floor(t*4),3)))*exp(-6*mod(t,0.25)), "
                "0.5*sin(2*PI*65*t)*exp(-2.5*mod(t,0.35)) + 0.35*sin(2*PI*523.25*t*(1+0.25*mod(floor(t*8),4)))*exp(-5*mod(t,0.125))"
                "))':s=44100:d=30"
            ),
            "cues": [
                {"label": "🥁 Intro Beat", "start_time": 0.0, "end_time": None, "color": "#38bdf8", "fade_in": 1},
                {"label": "🔥 Main Drop", "start_time": 6.0, "end_time": None, "color": "#f97316", "fade_in": 0},
                {"label": "⚡ Finale / Climax", "start_time": 18.0, "end_time": None, "color": "#ef4444", "fade_in": 0},
            ],
        },
        {
            "filename": "demo_spannung_heartbeat.mp3",
            "title": "Spannung vor dem Versuch (Demo)",
            "artist": "Arena FX",
            "category": "tension",
            "color": "#a855f7",
            "filter": (
                "aevalsrc='"
                "if(lt(t,10), 0.5*sin(2*PI*50*t)*(exp(-12*mod(t,1.0)) + 0.6*exp(-12*mod(t-0.22,1.0))), "
                "0.55*sin(2*PI*55*t)*(exp(-14*mod(t,0.6)) + 0.7*exp(-14*mod(t-0.16,0.6))) + 0.18*sin(2*PI*(220+t*15)*t)"
                ")':s=44100:d=22"
            ),
            "cues": [
                {"label": "💓 Ruhiger Puls", "start_time": 0.0, "end_time": None, "color": "#a855f7", "fade_in": 1},
                {"label": "🚨 Schneller Puls + Riser", "start_time": 10.0, "end_time": None, "color": "#ec4899", "fade_in": 1},
            ],
        },
        {
            "filename": "demo_sieger_fanfare.mp3",
            "title": "Punktgewinn / Applaus-Jingle (Demo)",
            "artist": "Show Opener",
            "category": "jingles",
            "color": "#22c55e",
            "filter": (
                "aevalsrc='"
                "if(lt(t,4), (0.3*sin(2*PI*261.63*t)+0.25*sin(2*PI*329.63*t)+0.25*sin(2*PI*392.00*t))*exp(-1.5*mod(t,1.0)), "
                "(0.35*sin(2*PI*523.25*t)+0.25*sin(2*PI*659.25*t)+0.25*sin(2*PI*783.99*t))*exp(-0.4*(t-4))"
                ")':s=44100:d=10"
            ),
            "cues": [
                {"label": "🎺 Fanfare Start", "start_time": 0.0, "end_time": 9.5, "color": "#22c55e", "fade_in": 0},
                {"label": "🏆 Sieger-Akkord", "start_time": 4.0, "end_time": 9.5, "color": "#eab308", "fade_in": 0},
            ],
        },
    ]

    conn = get_db()
    for idx, demo in enumerate(demos):
        filepath = UPLOADS_DIR / demo["filename"]
        if not filepath.exists():
            try:
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-v",
                        "error",
                        "-f",
                        "lavfi",
                        "-i",
                        demo["filter"],
                        "-codec:a",
                        "libmp3lame",
                        "-qscale:a",
                        "4",
                        str(filepath),
                    ],
                    check=True,
                    timeout=15,
                )
            except Exception as e:
                print(f"Konnte Demo-Audio nicht erstellen ({demo['filename']}): {e}")
                continue

        duration, peaks = compute_audio_info_and_peaks(filepath)
        cur = conn.execute(
            """
            INSERT INTO tracks (title, artist, filename, category_id, duration, volume, color, peaks_json, sort_order)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                demo["title"],
                demo["artist"],
                demo["filename"],
                demo["category"],
                duration,
                1.0,
                demo["color"],
                json.dumps(peaks),
                idx,
            ),
        )
        track_id = cur.lastrowid
        for c_idx, cue in enumerate(demo["cues"]):
            conn.execute(
                """
                INSERT INTO cues (track_id, label, start_time, end_time, color, fade_in, sort_order)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    track_id,
                    cue["label"],
                    cue["start_time"],
                    cue["end_time"],
                    cue["color"],
                    cue["fade_in"],
                    c_idx,
                ),
            )
    conn.commit()
    conn.close()


def init_db():
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS categories (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            icon TEXT NOT NULL DEFAULT '🎵',
            sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            artist TEXT NOT NULL DEFAULT '',
            filename TEXT NOT NULL,
            category_id TEXT NOT NULL DEFAULT 'action',
            duration REAL NOT NULL DEFAULT 0,
            volume REAL NOT NULL DEFAULT 1.0,
            color TEXT NOT NULL DEFAULT '#f97316',
            loop INTEGER NOT NULL DEFAULT 0,
            peaks_json TEXT NOT NULL DEFAULT '[]',
            sort_order INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS cues (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
            label TEXT NOT NULL,
            start_time REAL NOT NULL DEFAULT 0.0,
            end_time REAL DEFAULT NULL,
            color TEXT NOT NULL DEFAULT '#f97316',
            fade_in INTEGER NOT NULL DEFAULT 1,
            sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        """
    )

    # Standard-Kategorien anlegen, falls noch leer
    cat_count = conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0]
    if cat_count == 0:
        default_categories = [
            ("action", "Zwischen Athleten", "🔥", 1),
            ("walkin", "Einlauf / Start", "🚶", 2),
            ("tension", "Spannung / Finale", "⚡", 3),
            ("jingles", "Jingles & Effekte", "🎉", 4),
            ("ceremony", "Siegerehrung & Pause", "🏅", 5),
        ]
        conn.executemany(
            "INSERT INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)",
            default_categories,
        )

    # Standard-Settings
    default_settings = {
        "fade_in_duration": "1.5",
        "fade_out_duration": "2.0",
        "ducking_volume": "0.20",
        "ducking_fade": "0.6",
        "master_volume": "0.85",
        "auto_fade_enabled": "true",
        "auto_next_enabled": "true",
        "shuffle_enabled": "false",
        "crossfade_enabled": "true",
        "crossfade_duration": "4.0",
        "auth_enabled": "true",
        "auth_require_on_localhost": "false",
        "view_mode": "grid",
        "output_mode": "server",
        "panel_order": "songs,fader,deck",
        "language": "de",
        "design_theme": "studio",
    }
    for k, v in default_settings.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v)
        )

    # Kryptografische Secrets & initialer Zugriffsschutz anlegen
    existing_settings = {
        r["key"]: r["value"]
        for r in conn.execute("SELECT key, value FROM settings").fetchall()
    }
    if "cookie_secret" not in existing_settings:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('cookie_secret', ?)",
            (secrets.token_hex(32),),
        )
    if "access_token" not in existing_settings:
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('access_token', ?)",
            (secrets.token_urlsafe(18),),
        )
    if "auth_password_hash" not in existing_settings:
        initial_pin = str(secrets.randbelow(900000) + 100000)
        salt = secrets.token_hex(16)
        pw_hash = hash_password(initial_pin, salt)
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('auth_password_salt', ?)",
            (salt,),
        )
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('auth_password_hash', ?)",
            (pw_hash,),
        )
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('auth_initial_pin_hint', ?)",
            (initial_pin,),
        )

    track_count = conn.execute("SELECT COUNT(*) FROM tracks").fetchone()[0]
    initialized_before = conn.execute(
        "SELECT value FROM settings WHERE key = 'demo_seeded'"
    ).fetchone()

    conn.commit()
    conn.close()

    if track_count == 0 and not initialized_before:
        generate_demo_audio_files()
        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('demo_seeded', '1')"
        )
        conn.commit()
        conn.close()


def load_all_settings() -> dict[str, str]:
    conn = get_db()
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}


def load_tracks_and_settings() -> tuple[list[dict], dict[str, str]]:
    conn = get_db()
    tracks_rows = conn.execute(
        "SELECT * FROM tracks ORDER BY sort_order ASC, id DESC"
    ).fetchall()
    cues_rows = conn.execute(
        "SELECT * FROM cues ORDER BY start_time ASC, id ASC"
    ).fetchall()
    settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
    conn.close()

    cues_by_track: dict[int, list[dict]] = {}
    for c in cues_rows:
        cd = dict(c)
        cd["fade_in"] = bool(cd["fade_in"])
        cues_by_track.setdefault(cd["track_id"], []).append(cd)

    tracks = []
    for t in tracks_rows:
        td = dict(t)
        td["loop"] = bool(td["loop"])
        td.pop("peaks_json", None)
        td["cues"] = cues_by_track.get(td["id"], [])
        tracks.append(td)

    settings = {r["key"]: r["value"] for r in settings_rows}
    return tracks, settings


PLAYER_ENGINE: ServerAudioEngine | None = None


class ArenaDJRequestHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        # Ruhiges Logging für saubere Konsole
        pass

    def is_localhost_client(self) -> bool:
        client_ip = self.client_address[0]
        return client_ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1")

    def build_session_cookie_header(self, settings: dict[str, str], clear: bool = False) -> str:
        if clear:
            return f"{SESSION_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax"
        sig = compute_session_signature(settings)
        return f"{SESSION_COOKIE_NAME}={sig}; Path=/; Max-Age={SESSION_MAX_AGE}; HttpOnly; SameSite=Lax"

    def is_authenticated(self, settings: dict[str, str] | None = None) -> tuple[bool, bool]:
        """
        Prüft, ob die aktuelle Anfrage autorisiert ist.
        Gibt (authorized, matched_via_url_token) zurück.
        """
        if settings is None:
            settings = load_all_settings()

        if settings.get("auth_enabled", "true") == "false":
            return True, False

        if self.is_localhost_client() and settings.get("auth_require_on_localhost", "false") == "false":
            return True, False

        expected_token = settings.get("access_token", "")
        expected_sig = compute_session_signature(settings)

        # 1. URL-Query ?token=... prüfen (Magic Link fürs iPad)
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        url_token = (qs.get("token") or [""])[0]
        if url_token and expected_token and hmac.compare_digest(url_token, expected_token):
            return True, True

        # 2. Authorization: Bearer <token> prüfen
        auth_header = self.headers.get("Authorization", "")
        if auth_header.startswith("Bearer "):
            bearer = auth_header[7:].strip()
            if bearer and expected_token and hmac.compare_digest(bearer, expected_token):
                return True, False

        # 3. Session-Cookie prüfen
        cookie_raw = self.headers.get("Cookie", "")
        if cookie_raw:
            cookie = SimpleCookie()
            try:
                cookie.load(cookie_raw)
                if SESSION_COOKIE_NAME in cookie:
                    cookie_val = cookie[SESSION_COOKIE_NAME].value
                    if cookie_val and hmac.compare_digest(cookie_val, expected_sig):
                        return True, False
            except Exception:
                pass

        return False, False

    def send_json(self, data: dict | list, status: int = 200, extra_headers: dict[str, str] | None = None):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if extra_headers:
            for hk, hv in extra_headers.items():
                self.send_header(hk, hv)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self.send_header(
            "Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS"
        )
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range, Authorization")
        self.end_headers()

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        settings = load_all_settings()
        authed, via_url_token = self.is_authenticated(settings)

        # Wenn ein gültiger ?token=... Link aufgerufen wurde -> Cookie setzen & URL bereinigen!
        if authed and via_url_token and path in ("/", "", "/index.html"):
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Set-Cookie", self.build_session_cookie_header(settings))
            self.send_header("Location", "/")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        if path == "/api/state":
            if not authed:
                return self.send_json({"error": "Nicht autorisiert"}, 401)
            return self.handle_get_state()
        if path == "/api/player/status":
            if not authed:
                return self.send_json({"error": "Nicht autorisiert"}, 401)
            status = PLAYER_ENGINE.get_status() if PLAYER_ENGINE else {"audio_available": False}
            return self.send_json(status)
        if path == "/api/auth/qr.svg":
            if not authed:
                return self.send_json({"error": "Nicht autorisiert"}, 401)
            port = self.server.server_address[1]
            local_ip = get_local_ip()
            access_token = settings.get("access_token", "")
            magic_url = f"http://{local_ip}:{port}/?token={urllib.parse.quote(access_token)}"
            svg_bytes = generate_qr_svg(magic_url).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "image/svg+xml; charset=utf-8")
            self.send_header("Content-Length", str(len(svg_bytes)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(svg_bytes)
            return
        if path == "/api/export":
            if not authed:
                return self.send_json({"error": "Nicht autorisiert"}, 401)
            return self.handle_export()
        if path == "/api/system/update-check":
            if not authed:
                return self.send_json({"error": "Nicht autorisiert"}, 401)
            return self.send_json(check_github_updates())
        if path == "/api/spotdl/status":
            if not authed:
                return self.send_json({"error": "Nicht autorisiert"}, 401)
            return self.send_json(get_spotdl_job_status())
        if path.startswith("/media/"):
            if not authed:
                return self.send_json({"error": "Nicht autorisiert"}, 401)
            filename = urllib.parse.unquote(path[len("/media/") :])
            return self.serve_media_with_range(filename)

        public_icon_paths = {
            "/icon.svg",
            "/favicon.ico",
            "/apple-touch-icon.png",
            "/icon-192.png",
            "/icon-512.png",
            "/manifest.webmanifest",
        }

        # Nicht eingeloggt -> Login-Sperrbildschirm anzeigen (Icons bleiben öffentlich ladbar)
        if not authed and path not in public_icon_paths:
            login_file = STATIC_DIR / "login.html"
            lang = settings.get("language", "de")
            if lang not in ("de", "en", "fr"):
                lang = "de"
            html_str = login_file.read_text(encoding="utf-8").replace(
                'data-server-lang="de"', f'data-server-lang="{lang}"'
            )
            data = html_str.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(data)
            return

        # Statische Dateien aus /static ausliefern
        if path == "/" or path == "":
            path = "/index.html"

        safe_rel = path.lstrip("/")
        file_path = (STATIC_DIR / safe_rel).resolve()
        if not str(file_path).startswith(str(STATIC_DIR.resolve())) or not file_path.is_file():
            self.send_error(404, "Datei nicht gefunden")
            return

        ctype, _ = mimetypes.guess_type(str(file_path))
        ctype = ctype or "application/octet-stream"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def serve_media_with_range(self, filename: str):
        """
        Liefert Audio-Dateien inkl. HTTP Range Support (206 Partial Content) aus.
        Das ist essenziell, damit iPad/iPhone (Safari) und Chrome sofort an beliebige
        Sekunden-Positionen (Highlights/Cue-Points) springen können.
        """
        safe_name = os.path.basename(filename)
        file_path = UPLOADS_DIR / safe_name
        if not file_path.is_file():
            self.send_error(404, "Audio-Datei nicht gefunden")
            return

        file_size = file_path.stat().st_size
        ctype, _ = mimetypes.guess_type(str(file_path))
        if not ctype:
            ctype = "audio/mpeg"

        range_header = self.headers.get("Range")
        if range_header:
            m = re.match(r"bytes=(\d*)-(\d*)", range_header)
            if m:
                start_str, end_str = m.groups()
                start = int(start_str) if start_str else 0
                end = int(end_str) if end_str else file_size - 1
                if start >= file_size:
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{file_size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                end = min(end, file_size - 1)
                chunk_len = end - start + 1

                self.send_response(HTTPStatus.PARTIAL_CONTENT)
                self.send_header("Content-Type", ctype)
                self.send_header("Accept-Ranges", "bytes")
                self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
                self.send_header("Content-Length", str(chunk_len))
                self.end_headers()

                if self.command == "HEAD":
                    return

                with open(file_path, "rb") as f:
                    f.seek(start)
                    remaining = chunk_len
                    while remaining > 0:
                        buf = f.read(min(65536, remaining))
                        if not buf:
                            break
                        try:
                            self.wfile.write(buf)
                        except (BrokenPipeError, ConnectionResetError):
                            break
                        remaining -= len(buf)
                return

        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(file_size))
        self.end_headers()
        if self.command == "HEAD":
            return
        with open(file_path, "rb") as f:
            try:
                shutil.copyfileobj(f, self.wfile)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def handle_get_state(self):
        conn = get_db()
        categories = [
            dict(row)
            for row in conn.execute(
                "SELECT * FROM categories ORDER BY sort_order ASC, name ASC"
            ).fetchall()
        ]
        tracks_rows = conn.execute(
            "SELECT * FROM tracks ORDER BY sort_order ASC, id DESC"
        ).fetchall()
        cues_rows = conn.execute(
            "SELECT * FROM cues ORDER BY start_time ASC, id ASC"
        ).fetchall()
        settings_rows = conn.execute("SELECT key, value FROM settings").fetchall()
        conn.close()

        cues_by_track: dict[int, list[dict]] = {}
        for c in cues_rows:
            cd = dict(c)
            cd["fade_in"] = bool(cd["fade_in"])
            cues_by_track.setdefault(cd["track_id"], []).append(cd)

        tracks = []
        for t in tracks_rows:
            td = dict(t)
            td["loop"] = bool(td["loop"])
            try:
                td["peaks"] = json.loads(td.pop("peaks_json", "[]"))
            except Exception:
                td["peaks"] = []
            td["url"] = f"/media/{urllib.parse.quote(td['filename'])}"
            td["cues"] = cues_by_track.get(td["id"], [])
            tracks.append(td)

        raw_settings = {r["key"]: r["value"] for r in settings_rows}
        public_settings = {
            k: v
            for k, v in raw_settings.items()
            if k not in INTERNAL_SECRET_KEYS and k not in ("access_token", "auth_initial_pin_hint")
        }

        port = self.server.server_address[1]
        local_ip = get_local_ip()
        access_token = raw_settings.get("access_token", "")
        lan_url = f"http://{local_ip}:{port}"
        magic_lan_url = f"{lan_url}/?token={urllib.parse.quote(access_token)}"

        self.send_json(
            {
                "categories": categories,
                "tracks": tracks,
                "settings": public_settings,
                "server_info": {
                    "local_ip": local_ip,
                    "port": port,
                    "lan_url": lan_url,
                    "magic_lan_url": magic_lan_url,
                },
                "auth_info": {
                    "auth_enabled": raw_settings.get("auth_enabled", "true") != "false",
                    "auth_require_on_localhost": raw_settings.get("auth_require_on_localhost", "false") == "true",
                    "access_token": access_token,
                    "initial_pin_hint": raw_settings.get("auth_initial_pin_hint"),
                    "has_custom_password": "auth_initial_pin_hint" not in raw_settings,
                    "is_localhost": self.is_localhost_client(),
                },
                "player_status": PLAYER_ENGINE.get_status() if PLAYER_ENGINE else {"audio_available": False},
                "system_version": get_local_git_info(),
            }
        )

    def handle_export(self):
        conn = get_db()
        categories = [dict(r) for r in conn.execute("SELECT * FROM categories").fetchall()]
        tracks = [dict(r) for r in conn.execute("SELECT * FROM tracks").fetchall()]
        cues = [dict(r) for r in conn.execute("SELECT * FROM cues").fetchall()]
        settings = {
            r["key"]: r["value"]
            for r in conn.execute("SELECT key, value FROM settings").fetchall()
            if r["key"] not in INTERNAL_SECRET_KEYS and r["key"] not in ("access_token", "auth_initial_pin_hint")
        }
        conn.close()
        self.send_json(
            {
                "version": 1,
                "categories": categories,
                "tracks": tracks,
                "cues": cues,
                "settings": settings,
            }
        )

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # Login ist öffentlich erreichbar (mit Brute-Force-Schutz)
        if path == "/api/auth/login":
            return self.handle_auth_login()

        authed, _ = self.is_authenticated()
        if not authed:
            return self.send_json({"error": "Nicht autorisiert"}, 401)

        if path == "/api/player/command":
            return self.handle_player_command()

        if path == "/api/auth/logout":
            return self.handle_auth_logout()

        if path == "/api/auth/rotate-token":
            return self.handle_rotate_token()

        if path == "/api/auth/password":
            return self.handle_change_password()

        if path == "/api/tracks":
            return self.handle_upload_tracks()

        if path == "/api/tracks/bulk-delete":
            return self.handle_bulk_delete_tracks()

        m_cue = re.match(r"^/api/tracks/(\d+)/cues$", path)
        if m_cue:
            return self.handle_create_cue(int(m_cue.group(1)))

        if path == "/api/categories":
            return self.handle_create_category()

        if path == "/api/import":
            return self.handle_import()

        if path == "/api/system/update":
            return self.handle_system_update()

        if path == "/api/spotdl/start":
            return self.handle_spotdl_start()

        if path == "/api/spotdl/cancel":
            return self.handle_spotdl_cancel()

        self.send_error(404, "Endpoint nicht gefunden")

    def do_PUT(self):
        authed, _ = self.is_authenticated()
        if not authed:
            return self.send_json({"error": "Nicht autorisiert"}, 401)

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/tracks/reorder":
            return self.handle_reorder_tracks()

        m_track = re.match(r"^/api/tracks/(\d+)$", path)
        if m_track:
            return self.handle_update_track(int(m_track.group(1)))

        m_cue = re.match(r"^/api/cues/(\d+)$", path)
        if m_cue:
            return self.handle_update_cue(int(m_cue.group(1)))

        if path == "/api/settings":
            return self.handle_update_settings()

        self.send_error(404, "Endpoint nicht gefunden")

    def do_DELETE(self):
        authed, _ = self.is_authenticated()
        if not authed:
            return self.send_json({"error": "Nicht autorisiert"}, 401)

        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        m_track = re.match(r"^/api/tracks/(\d+)$", path)
        if m_track:
            return self.handle_delete_track(int(m_track.group(1)))

        m_cue = re.match(r"^/api/cues/(\d+)$", path)
        if m_cue:
            return self.handle_delete_cue(int(m_cue.group(1)))

        m_cat = re.match(r"^/api/categories/([a-zA-Z0-9_-]+)$", path)
        if m_cat:
            return self.handle_delete_category(m_cat.group(1))

        self.send_error(404, "Endpoint nicht gefunden")

    def handle_upload_tracks(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            return self.send_json({"error": "Multipart form-data erwartet"}, 400)

        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0:
            return self.send_json({"error": "Leerer Upload"}, 400)

        raw_body = self.rfile.read(content_length)
        header_bytes = f"Content-Type: {ctype}\r\nMIME-Version: 1.0\r\n\r\n".encode("utf-8")
        msg = BytesParser(policy=default_email_policy).parsebytes(header_bytes + raw_body)

        fields: dict[str, str] = {}
        uploaded_files: list[tuple[str, bytes]] = []

        for part in msg.iter_parts():
            cd = part.get("Content-Disposition", "")
            if "form-data" not in cd:
                continue
            field_name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            payload = part.get_payload(decode=True) or b""
            if filename:
                uploaded_files.append((filename, payload))
            elif field_name:
                fields[field_name] = payload.decode("utf-8", errors="replace")

        category_id = fields.get("category_id", "action")
        color = fields.get("color", "#f97316")

        created_ids = []
        conn = get_db()
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), -1) FROM tracks").fetchone()[0]

        palette = ["#f97316", "#38bdf8", "#a855f7", "#22c55e", "#eab308", "#ec4899"]

        for idx, (raw_filename, file_bytes) in enumerate(uploaded_files):
            orig_name = os.path.basename(raw_filename)
            stem, ext = os.path.splitext(orig_name)
            ext = ext.lower() if ext else ".mp3"
            safe_stem = re.sub(r"[^a-zA-Z0-9_-]+", "_", stem).strip("_") or "track"
            unique_filename = f"{safe_stem}_{uuid.uuid4().hex[:8]}{ext}"
            dest_path = UPLOADS_DIR / unique_filename

            dest_path.write_bytes(file_bytes)

            # Titel und optional Interpret aus Dateinamen erraten ("Artist - Title")
            artist = ""
            title = stem.replace("_", " ").strip()
            if " - " in title:
                parts = title.split(" - ", 1)
                artist = parts[0].strip()
                title = parts[1].strip()

            duration, peaks = compute_audio_info_and_peaks(dest_path)
            track_color = color if len(uploaded_files) == 1 else palette[idx % len(palette)]

            cur = conn.execute(
                """
                INSERT INTO tracks (title, artist, filename, category_id, duration, volume, color, peaks_json, sort_order)
                VALUES (?, ?, ?, ?, ?, 1.0, ?, ?, ?)
                """,
                (
                    title,
                    artist,
                    unique_filename,
                    category_id,
                    duration,
                    track_color,
                    json.dumps(peaks),
                    max_order + 1 + idx,
                ),
            )
            track_id = cur.lastrowid
            created_ids.append(track_id)

        conn.commit()
        conn.close()
        self.send_json({"ok": True, "created_ids": created_ids}, 201)

    def handle_reorder_tracks(self):
        data = self.read_json_body()
        track_ids = data.get("track_ids") or []
        if not isinstance(track_ids, list):
            return self.send_json({"error": "track_ids Liste erwartet"}, 400)

        conn = get_db()
        for idx, tid in enumerate(track_ids):
            conn.execute(
                "UPDATE tracks SET sort_order = ? WHERE id = ?",
                (idx, int(tid)),
            )
        conn.commit()
        conn.close()
        if PLAYER_ENGINE:
            tracks, _ = load_tracks_and_settings()
            PLAYER_ENGINE.refresh_track_metadata(tracks)
        self.send_json({"ok": True})

    def handle_update_track(self, track_id: int):
        data = self.read_json_body()
        conn = get_db()
        existing = conn.execute(
            "SELECT * FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not existing:
            conn.close()
            return self.send_json({"error": "Lied nicht gefunden"}, 404)

        title = data.get("title", existing["title"])
        artist = data.get("artist", existing["artist"])
        category_id = data.get("category_id", existing["category_id"])
        volume = float(data.get("volume", existing["volume"]))
        color = data.get("color", existing["color"])
        loop = 1 if data.get("loop", bool(existing["loop"])) else 0
        duration = float(data.get("duration", existing["duration"]))
        peaks_json = (
            json.dumps(data["peaks"])
            if "peaks" in data
            else existing["peaks_json"]
        )

        conn.execute(
            """
            UPDATE tracks
            SET title = ?, artist = ?, category_id = ?, volume = ?, color = ?, loop = ?, duration = ?, peaks_json = ?
            WHERE id = ?
            """,
            (title, artist, category_id, volume, color, loop, duration, peaks_json, track_id),
        )
        conn.commit()
        conn.close()
        if PLAYER_ENGINE:
            tracks, _ = load_tracks_and_settings()
            PLAYER_ENGINE.refresh_track_metadata(tracks)
        self.send_json({"ok": True})

    def handle_delete_track(self, track_id: int):
        conn = get_db()
        row = conn.execute(
            "SELECT filename FROM tracks WHERE id = ?", (track_id,)
        ).fetchone()
        if not row:
            conn.close()
            return self.send_json({"error": "Lied nicht gefunden"}, 404)

        conn.execute("DELETE FROM tracks WHERE id = ?", (track_id,))
        conn.commit()
        conn.close()

        filepath = UPLOADS_DIR / os.path.basename(row["filename"])
        if filepath.is_file():
            try:
                filepath.unlink()
            except Exception:
                pass
        if PLAYER_ENGINE:
            tracks, _ = load_tracks_and_settings()
            PLAYER_ENGINE.refresh_track_metadata(tracks)
        self.send_json({"ok": True})

    def handle_bulk_delete_tracks(self):
        data = self.read_json_body()
        raw_ids = data.get("track_ids") or []
        if not isinstance(raw_ids, list) or not raw_ids:
            return self.send_json({"error": "Keine Lieder zum Löschen ausgewählt."}, 400)

        clean_ids: list[int] = []
        for x in raw_ids:
            try:
                clean_ids.append(int(x))
            except (TypeError, ValueError):
                pass
        if not clean_ids:
            return self.send_json({"error": "Ungültige Lied-IDs."}, 400)

        placeholders = ",".join("?" for _ in clean_ids)
        conn = get_db()
        rows = conn.execute(
            f"SELECT id, filename FROM tracks WHERE id IN ({placeholders})",
            tuple(clean_ids),
        ).fetchall()

        conn.execute(
            f"DELETE FROM tracks WHERE id IN ({placeholders})",
            tuple(clean_ids),
        )
        conn.commit()
        conn.close()

        deleted_ids_set = {r["id"] for r in rows}
        for r in rows:
            filepath = UPLOADS_DIR / os.path.basename(r["filename"])
            if filepath.is_file():
                try:
                    filepath.unlink()
                except Exception:
                    pass

        if PLAYER_ENGINE:
            status = PLAYER_ENGINE.get_status()
            if status.get("track_id") in deleted_ids_set:
                PLAYER_ENGINE.stop_immediate()
            tracks, _ = load_tracks_and_settings()
            PLAYER_ENGINE.refresh_track_metadata(tracks)

        self.send_json({"ok": True, "deleted_count": len(rows)})

    def handle_create_cue(self, track_id: int):
        data = self.read_json_body()
        label = (data.get("label") or "🔥 Highlight").strip()
        start_time = max(0.0, float(data.get("start_time", 0.0)))
        end_time_raw = data.get("end_time")
        end_time = (
            float(end_time_raw)
            if end_time_raw not in (None, "", 0, "0")
            else None
        )
        color = data.get("color", "#f97316")
        fade_in = 1 if data.get("fade_in", True) else 0

        conn = get_db()
        cur = conn.execute(
            """
            INSERT INTO cues (track_id, label, start_time, end_time, color, fade_in)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (track_id, label, round(start_time, 2), round(end_time, 2) if end_time else None, color, fade_in),
        )
        cue_id = cur.lastrowid
        conn.commit()
        conn.close()
        self.send_json({"ok": True, "id": cue_id}, 201)

    def handle_update_cue(self, cue_id: int):
        data = self.read_json_body()
        conn = get_db()
        existing = conn.execute(
            "SELECT * FROM cues WHERE id = ?", (cue_id,)
        ).fetchone()
        if not existing:
            conn.close()
            return self.send_json({"error": "Highlight nicht gefunden"}, 404)

        label = (data.get("label") or existing["label"]).strip()
        start_time = max(0.0, float(data.get("start_time", existing["start_time"])))
        if "end_time" in data:
            end_raw = data["end_time"]
            end_time = float(end_raw) if end_raw not in (None, "", 0, "0") else None
        else:
            end_time = existing["end_time"]
        color = data.get("color", existing["color"])
        fade_in = 1 if data.get("fade_in", bool(existing["fade_in"])) else 0

        conn.execute(
            """
            UPDATE cues
            SET label = ?, start_time = ?, end_time = ?, color = ?, fade_in = ?
            WHERE id = ?
            """,
            (label, round(start_time, 2), round(end_time, 2) if end_time else None, color, fade_in, cue_id),
        )
        conn.commit()
        conn.close()
        if PLAYER_ENGINE:
            tracks, _ = load_tracks_and_settings()
            PLAYER_ENGINE.refresh_track_metadata(tracks)
        self.send_json({"ok": True})

    def handle_delete_cue(self, cue_id: int):
        conn = get_db()
        conn.execute("DELETE FROM cues WHERE id = ?", (cue_id,))
        conn.commit()
        conn.close()
        if PLAYER_ENGINE:
            tracks, _ = load_tracks_and_settings()
            PLAYER_ENGINE.refresh_track_metadata(tracks)
        self.send_json({"ok": True})

    def handle_create_category(self):
        data = self.read_json_body()
        name = (data.get("name") or "").strip()
        icon = (data.get("icon") or "🎵").strip()
        if not name:
            return self.send_json({"error": "Name erforderlich"}, 400)
        cat_id = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or uuid.uuid4().hex[:6]

        conn = get_db()
        max_order = conn.execute("SELECT COALESCE(MAX(sort_order), 0) FROM categories").fetchone()[0]
        conn.execute(
            "INSERT OR REPLACE INTO categories (id, name, icon, sort_order) VALUES (?, ?, ?, ?)",
            (cat_id, name, icon, max_order + 1),
        )
        conn.commit()
        conn.close()
        self.send_json({"ok": True, "id": cat_id}, 201)

    def handle_delete_category(self, cat_id: str):
        conn = get_db()
        conn.execute("UPDATE tracks SET category_id = 'action' WHERE category_id = ?", (cat_id,))
        conn.execute("DELETE FROM categories WHERE id = ?", (cat_id,))
        conn.commit()
        conn.close()
        if PLAYER_ENGINE:
            tracks, _ = load_tracks_and_settings()
            PLAYER_ENGINE.refresh_track_metadata(tracks)
        self.send_json({"ok": True})

    def handle_auth_login(self):
        client_ip = self.client_address[0]
        allowed, retry_after = check_rate_limit(client_ip)
        if not allowed:
            return self.send_json(
                {
                    "error": f"Zu viele Fehlversuche. Bitte {retry_after} Sekunden warten."
                },
                429,
            )

        data = self.read_json_body()
        candidate = str(data.get("password") or "").strip()
        if not candidate:
            return self.send_json({"error": "Bitte Passwort oder PIN eingeben."}, 400)

        settings = load_all_settings()
        salt = settings.get("auth_password_salt", "")
        expected_hash = settings.get("auth_password_hash", "")
        access_token = settings.get("access_token", "")

        # Sowohl das Passwort/PIN als auch das geheime Token akzeptieren
        candidate_hash = hash_password(candidate, salt) if salt else ""
        pw_ok = bool(expected_hash) and hmac.compare_digest(candidate_hash, expected_hash)
        token_ok = bool(access_token) and hmac.compare_digest(candidate, access_token)

        if not (pw_ok or token_ok):
            record_failed_login(client_ip)
            return self.send_json({"error": "Falsches Passwort / PIN."}, 401)

        clear_failed_logins(client_ip)
        cookie_hdr = self.build_session_cookie_header(settings)
        self.send_json({"ok": True}, 200, extra_headers={"Set-Cookie": cookie_hdr})

    def handle_auth_logout(self):
        settings = load_all_settings()
        cookie_hdr = self.build_session_cookie_header(settings, clear=True)
        self.send_json({"ok": True}, 200, extra_headers={"Set-Cookie": cookie_hdr})

    def handle_rotate_token(self):
        new_token = secrets.token_urlsafe(18)
        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('access_token', ?)",
            (new_token,),
        )
        conn.commit()
        conn.close()

        settings = load_all_settings()
        cookie_hdr = self.build_session_cookie_header(settings)
        local_ip = get_local_ip()
        port = self.server.server_address[1]
        magic_lan_url = f"http://{local_ip}:{port}/?token={urllib.parse.quote(new_token)}"

        self.send_json(
            {
                "ok": True,
                "access_token": new_token,
                "magic_lan_url": magic_lan_url,
            },
            200,
            extra_headers={"Set-Cookie": cookie_hdr},
        )

    def handle_change_password(self):
        data = self.read_json_body()
        new_pw = str(data.get("password") or "").strip()
        if len(new_pw) < 4:
            return self.send_json(
                {"error": "Passwort / PIN muss mindestens 4 Zeichen lang sein."}, 400
            )

        salt = secrets.token_hex(16)
        pw_hash = hash_password(new_pw, salt)
        conn = get_db()
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_password_salt', ?)",
            (salt,),
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_password_hash', ?)",
            (pw_hash,),
        )
        conn.execute("DELETE FROM settings WHERE key = 'auth_initial_pin_hint'")
        conn.commit()
        conn.close()

        settings = load_all_settings()
        cookie_hdr = self.build_session_cookie_header(settings)
        self.send_json({"ok": True}, 200, extra_headers={"Set-Cookie": cookie_hdr})

    def handle_player_command(self):
        if PLAYER_ENGINE is None:
            return self.send_json({"error": "Server-Audio nicht initialisiert"}, 503)

        data = self.read_json_body()
        action = str(data.get("action") or "")
        tracks, settings = load_tracks_and_settings()

        if action == "trigger_cue":
            track_id = int(data.get("track_id", 0))
            cue_index = int(data.get("cue_index", 0))
            active_category = str(data.get("active_category") or "all")
            track = next((t for t in tracks if t["id"] == track_id), None)
            if not track:
                return self.send_json({"error": "Lied nicht gefunden"}, 404)
            cues = track.get("cues") or []
            cue = cues[cue_index] if 0 <= cue_index < len(cues) else None
            PLAYER_ENGINE.trigger_cue(track, cue, settings, active_category=active_category)
        elif action == "toggle_play_pause":
            PLAYER_ENGINE.toggle_play_pause(settings)
        elif action == "fade_out":
            PLAYER_ENGINE.fade_out(settings, advance_to_next=False)
        elif action == "stop":
            PLAYER_ENGINE.stop_immediate()
        elif action == "skip_next":
            active_category = str(data.get("active_category") or "")
            PLAYER_ENGINE.skip_next(settings, active_category=active_category or None)
        elif action == "set_category":
            with PLAYER_ENGINE.lock:
                PLAYER_ENGINE.active_category = str(data.get("active_category") or "all")
                PLAYER_ENGINE.planned_next_track_id = None
        elif action == "seek":
            PLAYER_ENGINE.seek(float(data.get("time", 0.0)))
        elif action == "talkover":
            active_val = data.get("active")
            PLAYER_ENGINE.set_talkover(active_val if isinstance(active_val, bool) else None, settings)
        elif action == "volume":
            vol = max(0.0, min(1.0, float(data.get("master_volume", 0.85))))
            PLAYER_ENGINE.master_volume = vol
            if data.get("persist"):
                conn = get_db()
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('master_volume', ?)",
                    (f"{vol:.2f}",),
                )
                conn.commit()
                conn.close()
        else:
            return self.send_json({"error": f"Unbekannte Aktion: {action}"}, 400)

        self.send_json({"ok": True, "player_status": PLAYER_ENGINE.get_status()})

    def handle_update_settings(self):
        data = self.read_json_body()
        forbidden = INTERNAL_SECRET_KEYS | {"access_token", "auth_initial_pin_hint"}
        conn = get_db()
        for k, v in data.items():
            if str(k) in forbidden:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (str(k), str(v)),
            )
        conn.commit()
        conn.close()

        settings = load_all_settings()
        if PLAYER_ENGINE:
            PLAYER_ENGINE.sync_settings(settings)
        cookie_hdr = self.build_session_cookie_header(settings)
        self.send_json({"ok": True}, 200, extra_headers={"Set-Cookie": cookie_hdr})

    def handle_import(self):
        data = self.read_json_body()
        forbidden = INTERNAL_SECRET_KEYS | {"access_token", "auth_initial_pin_hint"}
        conn = get_db()
        for k, v in (data.get("settings") or {}).items():
            if str(k) in forbidden:
                continue
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                (str(k), str(v)),
            )
        conn.commit()
        conn.close()
        if PLAYER_ENGINE:
            tracks, settings = load_tracks_and_settings()
            PLAYER_ENGINE.sync_settings(settings)
            PLAYER_ENGINE.refresh_track_metadata(tracks)
        self.send_json({"ok": True})

    def handle_system_update(self):
        result = perform_github_update()
        status_code = 200 if result.get("ok") else 400
        self.send_json(result, status_code)

        if result.get("ok") and result.get("restarting"):
            server_ref = self.server
            target_script = result.get("exec_script") or sys.argv[0]

            def _restart_process():
                time.sleep(0.45)
                try:
                    if PLAYER_ENGINE:
                        PLAYER_ENGINE.stop_immediate()
                except Exception:
                    pass
                try:
                    server_ref.server_close()
                except Exception:
                    pass
                os.execv(sys.executable, [sys.executable, target_script, *sys.argv[1:]])

            threading.Thread(target=_restart_process, daemon=True).start()

    def handle_spotdl_start(self):
        data = self.read_json_body()
        raw_query = str(data.get("query") or "").strip()
        category_id = str(data.get("category_id") or "__playlist__").strip()
        fallback_cat = str(data.get("fallback_category_id") or "action").strip()
        if fallback_cat == "all" or not fallback_cat:
            fallback_cat = "action"
        color = str(data.get("color") or "#22c55e").strip()
        res = start_spotdl_download_job(raw_query, category_id, fallback_cat, color)
        self.send_json(res, 200 if res.get("ok") else 400)

    def handle_spotdl_cancel(self):
        res = cancel_spotdl_download_job()
        self.send_json(res, 200)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def run_server(port: int = 8080):
    global PLAYER_ENGINE
    init_db()
    local_ip = get_local_ip()
    settings = load_all_settings()
    PLAYER_ENGINE = ServerAudioEngine(UPLOADS_DIR, load_tracks_and_settings)
    PLAYER_ENGINE.sync_settings(settings)

    token = settings.get("access_token", "")
    pin_hint = settings.get("auth_initial_pin_hint")
    server = ReusableThreadingHTTPServer(("0.0.0.0", port), ArenaDJRequestHandler)
    print("=" * 72)
    print("🎧 ARENA DJ SOUNDBOARD SERVER GESTARTET (ZUGRIFFSSCHUTZ & LIVE-MIXER)")
    print("=" * 72)
    print(f"💻 Auf diesem PC:             http://localhost:{port}")
    print(f"🔒 WLAN mit Passwort/PIN:     http://{local_ip}:{port}")
    print(f"🔑 Geheimer iPad-Direktlink:  http://{local_ip}:{port}/?token={token}")
    if pin_hint:
        print(f"📌 Start-PIN (änderbar):      {pin_hint}")
    else:
        print("📌 Passwort / PIN:            Eigenes Passwort aktiv")
    print("=" * 72)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        if PLAYER_ENGINE:
            PLAYER_ENGINE.stop_immediate()
        print("\nServer beendet.")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    run_server(port)
