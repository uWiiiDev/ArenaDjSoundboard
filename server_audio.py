"""
Arena DJ Soundboard – Zentraler Server-Audio-Mixer (Dual-Deck mit PipeWire / ALSA / ffplay)
Spielt Musik direkt über die Soundkarte des Server-Laptops ab – 100% unabhängig vom Browser!
Selbst wenn Browser-Tabs auf Laptop, iPad oder Handy neu geladen oder geschlossen werden,
läuft die Musik inkl. Crossfade, Master-Fader, Talkover & Auto-Next unterbrechungsfrei weiter.
"""

import math
from pathlib import Path
import shutil
import subprocess
import threading
import time
from typing import Callable

import numpy as np

SAMPLE_RATE = 48000
CHANNELS = 2
CHUNK_SEC = 0.05  # 50 ms pro Audio-Block (20 Updates/Sekunde für flüssige Fades)
FRAMES_PER_CHUNK = int(SAMPLE_RATE * CHUNK_SEC)  # 2400 Stereo-Samples
BYTES_PER_CHUNK = FRAMES_PER_CHUNK * CHANNELS * 2  # 9600 Bytes (int16 stereo)


class _DeckStream:
    def __init__(self, index: int):
        self.index = index
        self.proc: subprocess.Popen | None = None
        self.filepath: Path | None = None
        self.track: dict | None = None
        self.cue: dict | None = None
        self.current_time: float = 0.0
        self.duration: float = 0.0
        self.track_volume: float = 1.0
        self.loop: bool = False
        self.paused: bool = True

        # Fade-Animation
        self.fade_gain: float = 0.0
        self.fade_from: float = 0.0
        self.fade_to: float = 0.0
        self.fade_elapsed: float = 0.0
        self.fade_duration: float = 0.0
        self.fade_curve: str = "linear"  # linear | equalIn | equalOut
        self.stop_after_fade: bool = False
        self.eof_reached: bool = False

    def start_ffmpeg(self, filepath: Path, start_sec: float):
        self.close_proc()
        self.filepath = filepath
        self.current_time = max(0.0, float(start_sec))
        self.eof_reached = False
        self.paused = False

        cmd = [
            "ffmpeg",
            "-v",
            "error",
            "-ss",
            f"{self.current_time:.3f}",
            "-i",
            str(filepath),
            "-vn",
            "-f",
            "s16le",
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "-",
        ]
        self.proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=BYTES_PER_CHUNK * 4,
        )

    def set_fade(
        self,
        from_val: float,
        to_val: float,
        duration_sec: float,
        curve: str = "linear",
        stop_after: bool = False,
    ):
        self.fade_from = float(from_val)
        self.fade_to = float(to_val)
        self.fade_elapsed = 0.0
        self.fade_duration = max(0.0, float(duration_sec))
        self.fade_curve = curve
        self.stop_after_fade = stop_after
        if self.fade_duration <= 0.04:
            self.fade_gain = self.fade_to
            self.fade_duration = 0.0
            if stop_after:
                self.stop()
        else:
            self.fade_gain = self.fade_from

    def step_fade(self, dt: float) -> bool:
        """Gibt True zurück, wenn ein stop_after_fade gerade abgeschlossen wurde."""
        if self.fade_duration <= 0.0:
            return False
        self.fade_elapsed += dt
        p = min(1.0, self.fade_elapsed / self.fade_duration)
        if self.fade_curve == "equalIn":
            self.fade_gain = self.fade_to * math.sin(p * math.pi * 0.5)
        elif self.fade_curve == "equalOut":
            self.fade_gain = self.fade_from * math.cos(p * math.pi * 0.5)
        else:
            self.fade_gain = self.fade_from + (self.fade_to - self.fade_from) * p

        if p >= 1.0:
            self.fade_duration = 0.0
            self.fade_gain = self.fade_to
            if self.stop_after_fade:
                self.stop_after_fade = False
                self.stop()
                return True
        return False

    def read_chunk_float(self) -> np.ndarray | None:
        if self.paused or self.proc is None or self.proc.stdout is None:
            return None

        raw = b""
        while len(raw) < BYTES_PER_CHUNK:
            part = self.proc.stdout.read(BYTES_PER_CHUNK - len(raw))
            if not part:
                break
            raw += part

        if len(raw) == 0:
            self.eof_reached = True
            return None

        frames_got = len(raw) // (CHANNELS * 2)
        self.current_time += frames_got / SAMPLE_RATE

        if len(raw) < BYTES_PER_CHUNK:
            self.eof_reached = True
            raw = raw + b"\x00" * (BYTES_PER_CHUNK - len(raw))

        samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
        gain = max(0.0, min(1.5, self.track_volume * self.fade_gain))
        return samples * gain

    def pause(self):
        self.paused = True
        self.close_proc()

    def stop(self):
        self.paused = True
        self.fade_gain = 0.0
        self.fade_duration = 0.0
        self.stop_after_fade = False
        self.close_proc()

    def close_proc(self):
        proc = self.proc
        self.proc = None
        if proc is not None:
            try:
                if proc.stdout:
                    proc.stdout.close()
                proc.terminate()
                proc.wait(timeout=0.5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass


class ServerAudioEngine:
    """
    Hintergrund-Audio-Engine für den Hallen-PC.
    Steuert 2 parallele Decks inkl. Crossfade, Master-Fader, Talkover & Auto-Next.
    """

    def __init__(
        self,
        uploads_dir: Path,
        get_state_fn: Callable[[], tuple[list[dict], dict[str, str]]],
    ):
        self.uploads_dir = uploads_dir
        self.get_state_fn = get_state_fn
        self.lock = threading.RLock()

        self.decks = [_DeckStream(0), _DeckStream(1)]
        self.active_idx = 0

        # Master-Pegel & Talkover
        self.master_volume = 0.85
        self.is_talkover = False
        self.duck_multiplier = 1.0
        self.duck_from = 1.0
        self.duck_to = 1.0
        self.duck_elapsed = 0.0
        self.duck_duration = 0.0

        # Status-Flags
        self.is_fading_out = False
        self.is_crossfading = False
        self.manual_stop = False
        self.advance_after_fade = False
        self.active_category = "all"

        self.output_proc: subprocess.Popen | None = None
        self.audio_available = bool(
            shutil.which("ffmpeg")
            and (shutil.which("pw-play") or shutil.which("aplay") or shutil.which("ffplay"))
        )

        self._running = True
        self._thread = threading.Thread(target=self._mixer_loop, daemon=True)
        self._thread.start()

    def sync_settings(self, settings: dict[str, str]):
        with self.lock:
            self.master_volume = float(settings.get("master_volume", 0.85))

    def _open_output_sink(self) -> subprocess.Popen | None:
        if shutil.which("pw-play"):
            cmd = [
                "pw-play",
                "--raw",
                "--rate",
                str(SAMPLE_RATE),
                "--channels",
                str(CHANNELS),
                "--format",
                "s16",
                "--latency",
                "60ms",
                "-",
            ]
        elif shutil.which("aplay"):
            cmd = [
                "aplay",
                "-q",
                "-f",
                "S16_LE",
                "-c",
                str(CHANNELS),
                "-r",
                str(SAMPLE_RATE),
                "-",
            ]
        elif shutil.which("ffplay"):
            cmd = [
                "ffplay",
                "-nodisp",
                "-autoexit",
                "-loglevel",
                "quiet",
                "-f",
                "s16le",
                "-ac",
                str(CHANNELS),
                "-ar",
                str(SAMPLE_RATE),
                "-i",
                "pipe:0",
            ]
        else:
            return None

        try:
            return subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                bufsize=BYTES_PER_CHUNK * 2,
            )
        except Exception as e:
            print(f"Hinweis Server-Audio-Ausgabe: {e}")
            return None

    def _close_output_sink(self):
        proc = self.output_proc
        self.output_proc = None
        if proc is not None:
            try:
                if proc.stdin:
                    proc.stdin.close()
                proc.terminate()
                proc.wait(timeout=0.5)
            except Exception:
                try:
                    proc.kill()
                except Exception:
                    pass

    def trigger_cue(
        self,
        track: dict,
        cue: dict | None,
        settings: dict[str, str],
        active_category: str = "all",
        is_crossfade: bool = False,
        crossfade_sec: float | None = None,
    ):
        with self.lock:
            self.sync_settings(settings)
            self.active_category = active_category or "all"

            filepath = self.uploads_dir / Path(track["filename"]).name
            if not filepath.is_file():
                return

            auto_fade = settings.get("auto_fade_enabled", "true") != "false"
            xfade_enabled = settings.get("crossfade_enabled", "true") != "false"
            fade_in_cfg = float(settings.get("fade_in_duration", 1.5))
            xfade_cfg = float(settings.get("crossfade_duration", 4.0))

            start_time = float(cue.get("start_time", 0.0)) if cue else 0.0
            cue_wants_fade = bool(cue.get("fade_in", True)) if cue else True

            prev_deck = self.decks[self.active_idx]
            prev_playing = (not prev_deck.paused) and prev_deck.fade_gain > 0.02

            use_dual_xfade = prev_playing and (
                is_crossfade or (xfade_enabled and auto_fade)
            )

            if use_dual_xfade:
                dur = (
                    float(crossfade_sec)
                    if (is_crossfade and crossfade_sec)
                    else (fade_in_cfg if cue_wants_fade else 0.3)
                )
                prev_deck.set_fade(
                    prev_deck.fade_gain,
                    0.0,
                    dur,
                    curve="equalOut",
                    stop_after=True,
                )
                self.is_crossfading = True
                self.active_idx = 1 - self.active_idx
                target = self.decks[self.active_idx]
                fade_in_sec = dur if (cue_wants_fade or is_crossfade) else 0.04
                curve_in = "equalIn" if is_crossfade else "linear"
            else:
                other = self.decks[1 - self.active_idx]
                other.stop()
                self.is_crossfading = False
                target = prev_deck
                fade_in_sec = fade_in_cfg if (auto_fade and cue_wants_fade) else 0.04
                curve_in = "linear"

            self.manual_stop = False
            self.is_fading_out = False
            self.advance_after_fade = False

            target.track = track
            target.cue = cue or {
                "id": None,
                "label": "▶ Ab Anfang",
                "start_time": 0.0,
                "end_time": None,
            }
            target.duration = float(track.get("duration") or 0.0)
            target.track_volume = float(track.get("volume") or 1.0)
            target.loop = bool(track.get("loop", False))
            target.start_ffmpeg(filepath, start_time)

            if fade_in_sec > 0.05:
                target.set_fade(0.01, 1.0, fade_in_sec, curve=curve_in, stop_after=False)
            else:
                target.set_fade(1.0, 1.0, 0.0)

    def toggle_play_pause(self, settings: dict[str, str]):
        with self.lock:
            self.sync_settings(settings)
            active = self.decks[self.active_idx]
            if active.track is None:
                tracks, _ = self.get_state_fn()
                if tracks:
                    first = tracks[0]
                    self.trigger_cue(first, None, settings)
                return

            if active.paused:
                filepath = self.uploads_dir / Path(active.track["filename"]).name
                if not filepath.is_file():
                    return
                self.manual_stop = False
                self.is_fading_out = False
                auto_fade = settings.get("auto_fade_enabled", "true") != "false"
                fade_sec = float(settings.get("fade_in_duration", 1.2)) if auto_fade else 0.04
                resume_pos = active.current_time
                if active.duration > 0 and resume_pos >= active.duration - 0.3:
                    resume_pos = 0.0
                active.start_ffmpeg(filepath, resume_pos)
                active.set_fade(0.05, 1.0, fade_sec, curve="linear")
            else:
                self.manual_stop = True
                self.is_fading_out = False
                self.is_crossfading = False
                for d in self.decks:
                    d.pause()

    def seek(self, position_sec: float):
        with self.lock:
            active = self.decks[self.active_idx]
            if active.track is None:
                return
            filepath = self.uploads_dir / Path(active.track["filename"]).name
            if not filepath.is_file():
                return
            was_paused = active.paused
            clamped = max(0.0, float(position_sec))
            if was_paused:
                active.current_time = clamped
            else:
                active.start_ffmpeg(filepath, clamped)

    def fade_out(self, settings: dict[str, str], advance_to_next: bool = False):
        with self.lock:
            active = self.decks[self.active_idx]
            if active.paused:
                return
            if not advance_to_next:
                self.manual_stop = True
            self.advance_after_fade = advance_to_next
            self.is_fading_out = True
            self.is_crossfading = False
            fade_sec = float(settings.get("fade_out_duration", 2.0))

            other = self.decks[1 - self.active_idx]
            if not other.paused:
                other.set_fade(other.fade_gain, 0.0, fade_sec, curve="linear", stop_after=True)
            active.set_fade(active.fade_gain, 0.0, fade_sec, curve="linear", stop_after=True)

    def stop_immediate(self):
        with self.lock:
            self.manual_stop = True
            self.is_fading_out = False
            self.is_crossfading = False
            self.advance_after_fade = False
            for d in self.decks:
                d.stop()

    def set_talkover(self, active_state: bool | None, settings: dict[str, str]):
        with self.lock:
            if active_state is None:
                self.is_talkover = not self.is_talkover
            else:
                self.is_talkover = bool(active_state)
            target_duck = (
                float(settings.get("ducking_volume", 0.2)) if self.is_talkover else 1.0
            )
            self.duck_from = self.duck_multiplier
            self.duck_to = target_duck
            self.duck_elapsed = 0.0
            self.duck_duration = max(0.05, float(settings.get("ducking_fade", 0.6)))

    def refresh_track_metadata(self, updated_tracks: list[dict]):
        with self.lock:
            by_id = {t["id"]: t for t in updated_tracks}
            for d in self.decks:
                if d.track and d.track["id"] in by_id:
                    ut = by_id[d.track["id"]]
                    d.track = ut
                    d.track_volume = float(ut.get("volume") or 1.0)
                    d.loop = bool(ut.get("loop", False))

    def _pick_next_track(self, current_track: dict, tracks: list[dict]) -> dict | None:
        if not tracks:
            return None
        if self.active_category and self.active_category != "all":
            cat_list = [t for t in tracks if t.get("category_id") == self.active_category]
            idx = next((i for i, t in enumerate(cat_list) if t["id"] == current_track["id"]), -1)
            if idx != -1 and cat_list:
                return cat_list[(idx + 1) % len(cat_list)]

        same_cat = [
            t for t in tracks if t.get("category_id") == current_track.get("category_id")
        ]
        idx = next((i for i, t in enumerate(same_cat) if t["id"] == current_track["id"]), -1)
        if idx != -1 and same_cat:
            return same_cat[(idx + 1) % len(same_cat)]

        all_idx = next((i for i, t in enumerate(tracks) if t["id"] == current_track["id"]), 0)
        return tracks[(all_idx + 1) % len(tracks)]

    def skip_next(self, settings: dict[str, str]):
        with self.lock:
            tracks, _ = self.get_state_fn()
            active = self.decks[self.active_idx]
            cur_track = active.track or (tracks[0] if tracks else None)
            if not cur_track:
                return
            nxt = self._pick_next_track(cur_track, tracks)
            if not nxt:
                return
            xfade_on = settings.get("crossfade_enabled", "true") != "false"
            is_playing = not active.paused
            self.trigger_cue(
                nxt,
                None,
                settings,
                active_category=self.active_category,
                is_crossfade=(is_playing and xfade_on),
                crossfade_sec=float(settings.get("fade_out_duration", 2.0)),
            )

    def get_status(self) -> dict:
        with self.lock:
            active = self.decks[self.active_idx]
            other = self.decks[1 - self.active_idx]
            any_playing = (not active.paused) or (not other.paused)
            peak_fade = max(active.fade_gain if not active.paused else 0.0, other.fade_gain if not other.paused else 0.0)
            if not any_playing:
                peak_fade = 1.0
            eff_pct = round(self.master_volume * self.duck_multiplier * peak_fade * 100)

            return {
                "audio_available": self.audio_available,
                "is_playing": not active.paused,
                "is_fading_out": self.is_fading_out,
                "is_crossfading": self.is_crossfading and (not other.paused),
                "is_talkover_active": self.is_talkover,
                "current_track_id": active.track["id"] if active.track else None,
                "current_cue": active.cue,
                "current_time": round(active.current_time, 2),
                "duration": round(active.duration, 2),
                "effective_volume_pct": max(0, min(150, eff_pct)),
                "master_volume": round(self.master_volume, 3),
            }

    def _mixer_loop(self):
        while self._running:
            pcm_bytes: bytes | None = None

            with self.lock:
                any_active = any(not d.paused for d in self.decks)
                if not any_active:
                    self._close_output_sink()
                else:
                    # Ducking Schritt
                    if self.duck_duration > 0.0:
                        self.duck_elapsed += CHUNK_SEC
                        p = min(1.0, self.duck_elapsed / self.duck_duration)
                        self.duck_multiplier = self.duck_from + (self.duck_to - self.duck_from) * p
                        if p >= 1.0:
                            self.duck_duration = 0.0

                    # Beide Decks mischen
                    mixed = np.zeros(FRAMES_PER_CHUNK * CHANNELS, dtype=np.float32)
                    for d in self.decks:
                        if not d.paused:
                            chunk = d.read_chunk_float()
                            if chunk is not None:
                                mixed += chunk
                            stopped_by_fade = d.step_fade(CHUNK_SEC)
                            if stopped_by_fade and d.index == self.active_idx:
                                self.is_fading_out = False
                                if self.advance_after_fade and not self.manual_stop:
                                    self.advance_after_fade = False
                                    self._auto_advance_locked(use_crossfade=False)

                    # Crossfade-Status bereinigen, sobald Hintergrund-Deck fertig ist
                    if self.decks[1 - self.active_idx].paused:
                        self.is_crossfading = False

                    # Prüfen auf Loop, Highlight-Ende & Auto-Crossfade am aktiven Deck
                    self._check_transitions_locked()

                    bus_gain = max(0.0, min(1.5, self.master_volume * self.duck_multiplier))
                    mixed *= bus_gain
                    np.clip(mixed, -32768.0, 32767.0, out=mixed)
                    pcm_bytes = mixed.astype(np.int16).tobytes()

            if pcm_bytes is None:
                time.sleep(0.04)
                continue

            if self.output_proc is None or self.output_proc.poll() is not None:
                self._close_output_sink()
                self.output_proc = self._open_output_sink()

            if self.output_proc and self.output_proc.stdin:
                try:
                    self.output_proc.stdin.write(pcm_bytes)
                    self.output_proc.stdin.flush()
                except Exception:
                    self._close_output_sink()
                    time.sleep(CHUNK_SEC)
            else:
                # Falls keine Soundkarte vorhanden: Echtzeit-Takt simulieren
                time.sleep(CHUNK_SEC)

    def _check_transitions_locked(self):
        active = self.decks[self.active_idx]
        if active.paused or active.track is None:
            return

        cue = active.cue or {}
        end_time = cue.get("end_time")
        has_cue_end = end_time is not None and float(end_time) > float(cue.get("start_time", 0.0))

        # 1. Endlosschleife aktiv?
        if active.loop:
            if has_cue_end and active.current_time >= float(end_time):
                filepath = self.uploads_dir / Path(active.track["filename"]).name
                active.start_ffmpeg(filepath, float(cue.get("start_time", 0.0)))
                return
            if active.eof_reached:
                filepath = self.uploads_dir / Path(active.track["filename"]).name
                active.start_ffmpeg(filepath, 0.0)
                return
            return

        # 2. Reguläres Dateiende erreicht?
        if active.eof_reached:
            active.stop()
            if not self.manual_stop:
                self._auto_advance_locked(use_crossfade=False)
            return

        # 3. Vorzeitiger Crossfade oder Cue-Ende?
        if self.manual_stop or self.is_fading_out or self.is_crossfading:
            return

        tracks, settings = self.get_state_fn()
        auto_next = settings.get("auto_next_enabled", "true") != "false"
        xfade_on = settings.get("crossfade_enabled", "true") != "false"
        effective_end = float(end_time) if has_cue_end else active.duration

        if effective_end > 0:
            remaining = effective_end - active.current_time
            if auto_next and xfade_on and tracks:
                xfade_cfg = float(settings.get("crossfade_duration", 4.0))
                xfade_win = min(xfade_cfg, max(1.0, effective_end * 0.45))
                if 0.15 < remaining <= xfade_win and active.current_time > 0.4:
                    self._auto_advance_locked(use_crossfade=True, crossfade_sec=remaining)
                    return
            elif has_cue_end:
                fade_out_sec = min(1.5, float(settings.get("fade_out_duration", 1.5)))
                if remaining <= fade_out_sec:
                    self.fade_out(settings, advance_to_next=auto_next)

    def _auto_advance_locked(self, use_crossfade: bool = False, crossfade_sec: float | None = None):
        tracks, settings = self.get_state_fn()
        if settings.get("auto_next_enabled", "true") == "false" or not tracks:
            return
        active = self.decks[self.active_idx]
        if not active.track:
            return
        nxt = self._pick_next_track(active.track, tracks)
        if not nxt:
            return
        self.trigger_cue(
            nxt,
            None,
            settings,
            active_category=self.active_category,
            is_crossfade=use_crossfade,
            crossfade_sec=crossfade_sec,
        )
