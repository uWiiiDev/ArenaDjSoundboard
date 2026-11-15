"""
Arena DJ Soundboard – Zentraler Server-Audio-Mixer (Dual-Deck mit PipeWire / ALSA / ffplay)
Spielt Musik direkt über die Soundkarte des Server-Laptops ab – 100% unabhängig vom Browser!
Selbst wenn Browser-Tabs auf Laptop, iPad oder Handy neu geladen oder geschlossen werden,
läuft die Musik inkl. Crossfade, Master-Fader, Talkover & Auto-Next unterbrechungsfrei weiter.
"""

import math
from pathlib import Path
import random
import shutil
import subprocess
import threading
import time
from typing import Callable
import wave

import numpy as np

SAMPLE_RATE = 48000
CHANNELS = 2
CHUNK_SEC = 0.05  # 50 ms pro Audio-Block (20 Updates/Sekunde für flüssige Fades)
FRAMES_PER_CHUNK = int(SAMPLE_RATE * CHUNK_SEC)  # 2400 Stereo-Samples
BYTES_PER_CHUNK = FRAMES_PER_CHUNK * CHANNELS * 2  # 9600 Bytes (int16 stereo)

SFX_IDS = ("airhorn", "buzzer", "drumroll", "fanfare", "applause", "countdown")


def _synthesize_sfx_stereo(sfx_id: str) -> np.ndarray:
    """
    Erzeugt druckvolle, realistische Stereo-Arena-Soundeffekte (48 kHz, float32 in -32768..32767).
    """
    sr = SAMPLE_RATE
    rng = np.random.default_rng(abs(hash(sfx_id)) % (2**31))

    if sfx_id == "airhorn":
        # Klassisches Stadion-Airhorn: 2 kurze Stöße + 1 langer Stoß mit satten Obertönen & Hall
        dur = 2.15
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float32) / sr
        env = np.zeros(n, dtype=np.float32)
        blasts = [(0.0, 0.16), (0.21, 0.37), (0.43, 1.88)]
        for b_start, b_end in blasts:
            mask = (t >= b_start) & (t <= b_end)
            bt = t[mask] - b_start
            b_dur = b_end - b_start
            attack = np.minimum(1.0, bt / 0.012)
            release = np.minimum(1.0, (b_dur - bt) / 0.05)
            env[mask] = attack * release

        # Leichtes Pitch-Bend beim Anblasen + mehrstimmige Horn-Frequenzen
        freqs_l = [466.16, 587.33, 932.33, 937.1]
        freqs_r = [464.50, 589.10, 930.80, 935.4]
        sig_l = np.zeros(n, dtype=np.float32)
        sig_r = np.zeros(n, dtype=np.float32)
        vibrato = 1.0 + 0.004 * np.sin(2.0 * np.pi * 6.5 * t)
        for h in range(1, 8):
            weight = 1.0 / (h ** 0.78)
            for fl, fr in zip(freqs_l, freqs_r):
                if fl * h < 14000:
                    sig_l += weight * np.sin(2.0 * np.pi * (fl * h) * t * vibrato)
                    sig_r += weight * np.sin(2.0 * np.pi * (fr * h) * t * vibrato + 0.3)
        sig_l = np.tanh(sig_l * 0.48) * env
        sig_r = np.tanh(sig_r * 0.48) * env
        # Kurzes Hall-Echo
        delay = int(0.085 * sr)
        if n > delay:
            sig_l[delay:] += 0.24 * sig_r[:-delay] * np.exp(-t[:-delay] * 1.4)
            sig_r[delay:] += 0.24 * sig_l[:-delay] * np.exp(-t[:-delay] * 1.4)

    elif sfx_id == "buzzer":
        # Tiefer, massiver Hallen-Buzzer / Eishockey- & Basketball-Sirene
        dur = 1.95
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float32) / sr
        env = np.minimum(1.0, t / 0.015) * np.minimum(1.0, (dur - t) / 0.14)
        rattle = 0.78 + 0.22 * np.sin(2.0 * np.pi * 52.0 * t)
        base_freqs = [146.83, 185.00, 220.00, 293.66]
        sig_l = np.zeros(n, dtype=np.float32)
        sig_r = np.zeros(n, dtype=np.float32)
        for h in range(1, 10):
            w = 1.0 / (h ** 0.72)
            for idx_f, f in enumerate(base_freqs):
                det_l = 1.0 + 0.003 * (idx_f - 1.5)
                det_r = 1.0 - 0.003 * (idx_f - 1.5)
                sig_l += w * np.sin(2.0 * np.pi * f * h * det_l * t)
                sig_r += w * np.sin(2.0 * np.pi * f * h * det_r * t + 0.4)
        sig_l = np.tanh(sig_l * 0.55) * rattle * env
        sig_r = np.tanh(sig_r * 0.55) * rattle * env

    elif sfx_id == "drumroll":
        # Spannender Snare-Trommelwirbel (0..1.9s) + Becken-Crash & Punch-Kick am Ende!
        dur = 2.75
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float32) / sr
        sig_l = np.zeros(n, dtype=np.float32)
        sig_r = np.zeros(n, dtype=np.float32)

        roll_end = 1.92
        roll_mask = t < roll_end
        rt = t[roll_mask]
        crescendo = 0.28 + 0.72 * ((rt / roll_end) ** 1.45)
        # 28 Hz Wirbel-Impulse
        hits = np.abs(np.sin(np.pi * 28.0 * rt)) ** 3.2
        noise_l = rng.standard_normal(len(rt)).astype(np.float32)
        noise_r = rng.standard_normal(len(rt)).astype(np.float32)
        # Hochpass-Effekt für Snare-Teppich + 185 Hz Kessel-Resonanz
        snare_l = (noise_l - np.roll(noise_l, 1)) * 0.45 + 0.35 * np.sin(2.0 * np.pi * 185.0 * rt)
        snare_r = (noise_r - np.roll(noise_r, 1)) * 0.45 + 0.35 * np.sin(2.0 * np.pi * 189.0 * rt)
        sig_l[roll_mask] = snare_l * hits * crescendo
        sig_r[roll_mask] = snare_r * hits * crescendo

        # Finale bei 1.92s: Kick + Cymbal Crash
        crash_mask = t >= roll_end
        ct = t[crash_mask] - roll_end
        kick_freq = 60.0 + 110.0 * np.exp(-ct * 24.0)
        kick = np.sin(2.0 * np.pi * kick_freq * ct) * np.exp(-ct * 7.5) * 0.95
        cym_l = rng.standard_normal(len(ct)).astype(np.float32)
        cym_r = rng.standard_normal(len(ct)).astype(np.float32)
        cym_env = np.exp(-ct * 3.1)
        sig_l[crash_mask] = kick + (cym_l - 0.7 * np.roll(cym_l, 1)) * 0.38 * cym_env
        sig_r[crash_mask] = kick + (cym_r - 0.7 * np.roll(cym_r, 1)) * 0.38 * cym_env

    elif sfx_id == "fanfare":
        # Strahlende Sieger-Fanfare (C-Dur Blechbläser: C4 - E4 - G4 - C5!)
        dur = 2.45
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float32) / sr
        sig_l = np.zeros(n, dtype=np.float32)
        sig_r = np.zeros(n, dtype=np.float32)
        notes = [
            (0.00, 0.24, [261.63, 329.63, 523.25]),
            (0.26, 0.50, [329.63, 392.00, 659.25]),
            (0.52, 0.76, [392.00, 523.25, 783.99]),
            (0.80, 2.38, [261.63, 392.00, 523.25, 659.25, 1046.50]),
        ]
        for n_start, n_end, chord in notes:
            mask = (t >= n_start) & (t <= n_end)
            nt = t[mask] - n_start
            ndur = n_end - n_start
            env = np.minimum(1.0, nt / 0.018) * np.exp(-nt * 0.65) * np.minimum(1.0, (ndur - nt) / 0.06)
            for f in chord:
                for h, amp in [(1, 1.0), (2, 0.72), (3, 0.48), (4, 0.28), (5, 0.16)]:
                    sig_l[mask] += amp * np.sin(2.0 * np.pi * (f * h * 1.001) * nt) * env
                    sig_r[mask] += amp * np.sin(2.0 * np.pi * (f * h * 0.999) * nt + 0.25) * env
        sig_l = np.tanh(sig_l * 0.22)
        sig_r = np.tanh(sig_r * 0.22)

    elif sfx_id == "applause":
        # Stadion-Jubel & dichter Stereo-Applaus
        dur = 3.0
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float32) / sr
        master_env = np.minimum(1.0, t / 0.22) * np.minimum(1.0, (dur - t) / 0.55)
        sig_l = np.zeros(n, dtype=np.float32)
        sig_r = np.zeros(n, dtype=np.float32)
        # 240 versetzte Einzel-Klatscher im Stereo-Panorama
        for _ in range(240):
            c_start = int(rng.uniform(0.0, dur - 0.08) * sr)
            c_len = int(rng.uniform(0.025, 0.065) * sr)
            if c_start + c_len >= n:
                continue
            ct = np.arange(c_len, dtype=np.float32) / sr
            c_env = np.exp(-ct * rng.uniform(45.0, 75.0))
            burst = rng.standard_normal(c_len).astype(np.float32)
            # Bandpass-Färbung (Handflächen-Resonanz 1.1..2.6 kHz)
            f_res = rng.uniform(1100.0, 2600.0)
            clap = burst * np.sin(2.0 * np.pi * f_res * ct) * c_env
            pan = rng.uniform(0.15, 0.85)
            sig_l[c_start : c_start + c_len] += clap * pan
            sig_r[c_start : c_start + c_len] += clap * (1.0 - pan)
        sig_l = np.tanh(sig_l * 0.38) * master_env
        sig_r = np.tanh(sig_r * 0.38) * master_env

    else:  # "countdown"
        # 3 - 2 - 1 - GO! Wettkampf-Startsignal
        dur = 3.15
        n = int(sr * dur)
        t = np.arange(n, dtype=np.float32) / sr
        sig_l = np.zeros(n, dtype=np.float32)
        sig_r = np.zeros(n, dtype=np.float32)
        for beep_start in (0.02, 0.82, 1.62):
            mask = (t >= beep_start) & (t <= beep_start + 0.28)
            bt = t[mask] - beep_start
            env = np.minimum(1.0, bt / 0.008) * np.exp(-bt * 6.5)
            tone = np.sin(2.0 * np.pi * 880.0 * bt) + 0.35 * np.sin(2.0 * np.pi * 1760.0 * bt)
            sig_l[mask] += tone * env * 0.75
            sig_r[mask] += tone * env * 0.75
        # GO-Signal bei 2.42s (1760 Hz + Akkord)
        go_mask = (t >= 2.42) & (t <= 3.12)
        gt = t[go_mask] - 2.42
        go_env = np.minimum(1.0, gt / 0.01) * np.minimum(1.0, (0.70 - gt) / 0.08)
        go_l = (
            np.sin(2.0 * np.pi * 1760.0 * gt)
            + 0.55 * np.sin(2.0 * np.pi * 880.0 * gt)
            + 0.45 * np.sin(2.0 * np.pi * 1318.5 * gt)
        ) * go_env
        go_r = (
            np.sin(2.0 * np.pi * 1762.0 * gt)
            + 0.55 * np.sin(2.0 * np.pi * 879.0 * gt)
            + 0.45 * np.sin(2.0 * np.pi * 1320.0 * gt)
        ) * go_env
        sig_l[go_mask] += np.tanh(go_l * 0.65)
        sig_r[go_mask] += np.tanh(go_r * 0.65)

    stereo = np.column_stack((sig_l, sig_r))
    peak = float(np.max(np.abs(stereo)))
    if peak > 1e-5:
        stereo = stereo * (0.88 / peak)
    return (stereo.reshape(-1) * 32767.0).astype(np.float32)


def ensure_arena_sfx_files(sfx_dir: Path) -> dict[str, np.ndarray]:
    """
    Stellt sicher, dass alle 6 Arena-Soundeffekte als .wav in data/sfx/ liegen
    und gibt sie als float32-Stereo-Puffer für den Echtzeit-Server-Mixer zurück.
    """
    sfx_dir.mkdir(parents=True, exist_ok=True)
    buffers: dict[str, np.ndarray] = {}
    for sfx_id in SFX_IDS:
        wav_path = sfx_dir / f"{sfx_id}.wav"
        buf = _synthesize_sfx_stereo(sfx_id)
        buffers[sfx_id] = buf
        if not wav_path.exists():
            try:
                pcm_int16 = np.clip(buf, -32768.0, 32767.0).astype(np.int16).tobytes()
                with wave.open(str(wav_path), "wb") as wf:
                    wf.setnchannels(CHANNELS)
                    wf.setsampwidth(2)
                    wf.setframerate(SAMPLE_RATE)
                    wf.writeframes(pcm_int16)
            except Exception as e:
                print(f"Hinweis beim Erzeugen von {wav_path.name}: {e}")
    return buffers


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
        self.shuffle_enabled = False
        self.shuffle_history: list[int] = []
        self.planned_next_track_id: int | None = None

        # 5-Band Equalizer (60Hz, 250Hz, 1kHz, 4kHz, 12kHz) & 24-Band Live-Spektrumanalyzer
        self.eq_enabled: bool = True
        self.eq_preset: str = "flat"
        self.eq_freqs = np.array([60.0, 250.0, 1000.0, 4000.0, 12000.0], dtype=np.float32)
        self.eq_gains_db: list[float] = [0.0, 0.0, 0.0, 0.0, 0.0]
        self._eq_pad = 128
        self._eq_fft_len = FRAMES_PER_CHUNK + 2 * self._eq_pad
        self._eq_rfft_freqs = np.fft.rfftfreq(self._eq_fft_len, d=1.0 / SAMPLE_RATE)
        self._eq_curve = np.ones(len(self._eq_rfft_freqs), dtype=np.float32)
        self._eq_hist = np.zeros((self._eq_pad, CHANNELS), dtype=np.float32)
        self._update_eq_curve_locked()

        # 24 logarithmische Bänder (32 Hz .. 16 kHz) für den Live-Spektrumanalyzer
        self.num_spectrum_bands = 24
        self.spectrum_bands: list[float] = [0.0] * self.num_spectrum_bands
        self._spec_window = np.hanning(FRAMES_PER_CHUNK).astype(np.float32)
        spec_freqs = np.fft.rfftfreq(FRAMES_PER_CHUNK, d=1.0 / SAMPLE_RATE)
        edges = np.geomspace(32.0, 16000.0, self.num_spectrum_bands + 1)
        self._spec_bin_slices: list[tuple[int, int, float]] = []
        for b in range(self.num_spectrum_bands):
            lo = int(np.searchsorted(spec_freqs, edges[b], side="left"))
            hi = int(np.searchsorted(spec_freqs, edges[b + 1], side="right"))
            lo = max(1, min(lo, len(spec_freqs) - 1))
            hi = max(lo + 1, min(hi, len(spec_freqs)))
            # Leichte Höhen-Gewichtung (+2.2 dB/Oktave ab 250 Hz), damit Höhen optisch ausgewogen tanzen
            center_f = math.sqrt(float(edges[b] * edges[b + 1]))
            tilt = max(0.85, (center_f / 220.0) ** 0.28)
            self._spec_bin_slices.append((lo, hi, float(tilt)))

        self.output_proc: subprocess.Popen | None = None
        self.audio_available = bool(
            shutil.which("ffmpeg")
            and (shutil.which("pw-play") or shutil.which("aplay") or shutil.which("ffplay"))
        )

        # 🚨 Sofort-Soundeffekte / Jingles (Overlay-Kanal auf dem Hallen-Mixer)
        self.sfx_dir = self.uploads_dir.parent / "sfx"
        self.sfx_buffers: dict[str, np.ndarray] = ensure_arena_sfx_files(self.sfx_dir)
        self.active_sfx_id: str | None = None
        self.sfx_buffer: np.ndarray | None = None
        self.sfx_pos: int = 0
        self.sfx_duck_music: bool = True

        self._running = True
        self._thread = threading.Thread(target=self._mixer_loop, daemon=True)
        self._thread.start()

    def trigger_sfx(self, sfx_id: str, duck_music: bool = True):
        with self.lock:
            buf = self.sfx_buffers.get(str(sfx_id))
            if buf is None:
                return
            self.active_sfx_id = str(sfx_id)
            self.sfx_buffer = buf
            self.sfx_pos = 0
            self.sfx_duck_music = bool(duck_music)

    def stop_sfx(self):
        with self.lock:
            self.active_sfx_id = None
            self.sfx_buffer = None
            self.sfx_pos = 0

    def _update_eq_curve_locked(self):
        if not self.eq_enabled or all(abs(g) < 0.05 for g in self.eq_gains_db):
            self._eq_curve = np.ones(len(self._eq_rfft_freqs), dtype=np.float32)
            return
        log_f = np.log10(np.maximum(self._eq_rfft_freqs, 20.0))
        log_eq = np.log10(self.eq_freqs)
        gains = np.array([max(-12.0, min(12.0, float(g))) for g in self.eq_gains_db], dtype=np.float32)
        interp_db = np.interp(log_f, log_eq, gains)
        self._eq_curve = (10.0 ** (interp_db / 20.0)).astype(np.float32)

    def set_equalizer(
        self,
        enabled: bool | None = None,
        bands_db: list[float] | None = None,
        preset: str | None = None,
    ):
        with self.lock:
            if enabled is not None:
                self.eq_enabled = bool(enabled)
            if preset is not None:
                self.eq_preset = str(preset)
            if bands_db is not None and len(bands_db) >= 5:
                self.eq_gains_db = [
                    round(max(-12.0, min(12.0, float(x))), 1) for x in bands_db[:5]
                ]
            self._update_eq_curve_locked()

    def sync_settings(self, settings: dict[str, str]):
        with self.lock:
            self.master_volume = float(settings.get("master_volume", 0.85))
            new_shuffle = settings.get("shuffle_enabled", "false") == "true"
            if new_shuffle != self.shuffle_enabled:
                self.shuffle_enabled = new_shuffle
                self.planned_next_track_id = None
            if "eq_enabled" in settings:
                self.eq_enabled = settings.get("eq_enabled", "true") != "false"
            if "eq_preset" in settings:
                self.eq_preset = str(settings.get("eq_preset") or "flat")
            if "eq_bands" in settings:
                try:
                    parts = [float(x.strip()) for x in str(settings.get("eq_bands", "")).split(",") if x.strip()]
                    if len(parts) >= 5:
                        self.eq_gains_db = [round(max(-12.0, min(12.0, x)), 1) for x in parts[:5]]
                except Exception:
                    pass
            self._update_eq_curve_locked()

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
        resume_time: float | None = None,
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

            start_time = (
                max(0.0, float(resume_time))
                if resume_time is not None
                else (float(cue.get("start_time", 0.0)) if cue else 0.0)
            )
            cue_wants_fade = (
                False
                if resume_time is not None
                else (bool(cue.get("fade_in", True)) if cue else True)
            )

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

            tid = track.get("id")
            if tid is not None:
                self.shuffle_history.append(int(tid))
                if len(self.shuffle_history) > 250:
                    self.shuffle_history = self.shuffle_history[-250:]
            self.planned_next_track_id = None

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
                    if self.shuffle_enabled:
                        first = random.choice(tracks)
                    else:
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

    def _get_candidate_pool(self, current_track: dict, tracks: list[dict]) -> list[dict]:
        if not tracks:
            return []
        if self.active_category and self.active_category != "all":
            cat_list = [t for t in tracks if t.get("category_id") == self.active_category]
            if cat_list and any(t["id"] == current_track["id"] for t in cat_list):
                return cat_list
        if self.active_category == "all":
            return tracks
        same_cat = [
            t for t in tracks if t.get("category_id") == current_track.get("category_id")
        ]
        if same_cat:
            return same_cat
        return tracks

    def _pick_next_track(
        self, current_track: dict, tracks: list[dict], consume_planned: bool = True
    ) -> dict | None:
        pool = self._get_candidate_pool(current_track, tracks)
        if not pool:
            return None

        if self.shuffle_enabled:
            if len(pool) == 1:
                return pool[0]

            # Falls bereits ein Zufalls-Kandidat für die Vorab-Anzeige ausgelost wurde
            if self.planned_next_track_id is not None:
                planned = next(
                    (
                        t
                        for t in pool
                        if t["id"] == self.planned_next_track_id
                        and t["id"] != current_track["id"]
                    ),
                    None,
                )
                if planned is not None:
                    if consume_planned:
                        self.planned_next_track_id = None
                    return planned

            candidates = [t for t in pool if t["id"] != current_track["id"]]
            recent_window = max(0, len(pool) - 1)
            recent_ids = set(self.shuffle_history[-recent_window:]) if recent_window > 0 else set()
            fresh = [t for t in candidates if t["id"] not in recent_ids]
            chosen = random.choice(fresh if fresh else candidates)
            if not consume_planned:
                self.planned_next_track_id = chosen["id"]
            else:
                self.planned_next_track_id = None
            return chosen

        idx = next((i for i, t in enumerate(pool) if t["id"] == current_track["id"]), -1)
        if idx != -1:
            return pool[(idx + 1) % len(pool)]
        return pool[0]

    def skip_next(self, settings: dict[str, str], active_category: str | None = None):
        with self.lock:
            self.sync_settings(settings)
            if active_category:
                self.active_category = active_category
            tracks, _ = self.get_state_fn()
            active = self.decks[self.active_idx]
            cur_track = active.track or (tracks[0] if tracks else None)
            if not cur_track:
                return
            nxt = self._pick_next_track(cur_track, tracks, consume_planned=True)
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

            next_track_id = None
            if active.track:
                try:
                    tracks, _ = self.get_state_fn()
                    nxt = self._pick_next_track(active.track, tracks, consume_planned=False)
                    if nxt:
                        next_track_id = nxt["id"]
                except Exception:
                    pass

            sfx_active = self.sfx_buffer is not None and self.sfx_pos < len(self.sfx_buffer)

            return {
                "audio_available": self.audio_available,
                "is_playing": not active.paused,
                "is_fading_out": self.is_fading_out,
                "is_crossfading": self.is_crossfading and (not other.paused),
                "is_talkover_active": self.is_talkover,
                "shuffle_enabled": self.shuffle_enabled,
                "current_track_id": active.track["id"] if active.track else None,
                "next_track_id": next_track_id,
                "current_cue": active.cue,
                "current_time": round(active.current_time, 2),
                "duration": round(active.duration, 2),
                "effective_volume_pct": max(0, min(150, eff_pct)),
                "master_volume": round(self.master_volume, 3),
                "eq_enabled": self.eq_enabled,
                "eq_preset": self.eq_preset,
                "eq_bands": [round(float(g), 1) for g in self.eq_gains_db],
                "spectrum": [round(float(s), 1) for s in self.spectrum_bands],
                "active_sfx": self.active_sfx_id if sfx_active else None,
            }

    def _apply_eq_and_spectrum_locked(self, mixed_flat: np.ndarray) -> np.ndarray:
        stereo = mixed_flat.reshape((FRAMES_PER_CHUNK, CHANNELS))
        pad = self._eq_pad

        if self.eq_enabled and any(abs(g) >= 0.05 for g in self.eq_gains_db):
            right_pad = 2.0 * stereo[-1:] - stereo[-2 : -pad - 2 : -1]
            blk = np.vstack((self._eq_hist, stereo, right_pad))
            self._eq_hist = stereo[-pad:].copy()
            spec = np.fft.rfft(blk, axis=0)
            spec *= self._eq_curve[:, None]
            out_stereo = np.fft.irfft(spec, n=self._eq_fft_len, axis=0)[pad : pad + FRAMES_PER_CHUNK]
        else:
            self._eq_hist = stereo[-pad:].copy()
            out_stereo = stereo

        # 24-Band Live-Spektrumanalyzer berechnen (normierter Mono-Mix nach EQ)
        mono = (out_stereo[:, 0] + out_stereo[:, 1]) * (0.5 / 32768.0)
        fft_mag = np.abs(np.fft.rfft(mono * self._spec_window)) / (FRAMES_PER_CHUNK * 0.25)

        for idx, (lo, hi, tilt) in enumerate(self._spec_bin_slices):
            band_slice = fft_mag[lo:hi]
            if len(band_slice) == 0:
                raw_val = 0.0
            else:
                # Mischung aus Peak und RMS für lebendige, präzise Pegelausschläge
                peak_v = float(np.max(band_slice))
                rms_v = float(np.sqrt(np.mean(band_slice * band_slice)))
                mag = (0.65 * peak_v + 0.35 * rms_v) * tilt
                db = 20.0 * math.log10(max(mag, 1e-6))
                # -54 dB .. -2 dB auf 0 .. 100 abbilden
                raw_val = max(0.0, min(100.0, (db + 54.0) * (100.0 / 52.0)))

            prev_val = self.spectrum_bands[idx]
            if raw_val >= prev_val:
                self.spectrum_bands[idx] = prev_val * 0.28 + raw_val * 0.72
            else:
                self.spectrum_bands[idx] = max(0.0, prev_val * 0.62 + raw_val * 0.38 - 1.2)

        return out_stereo.reshape(-1)

    def _mixer_loop(self):
        while self._running:
            pcm_bytes: bytes | None = None

            with self.lock:
                any_active = any(not d.paused for d in self.decks)
                sfx_active = self.sfx_buffer is not None and self.sfx_pos < len(self.sfx_buffer)
                if not any_active and not sfx_active:
                    self._close_output_sink()
                    self._eq_hist.fill(0.0)
                    for i in range(self.num_spectrum_bands):
                        if self.spectrum_bands[i] > 0.1:
                            self.spectrum_bands[i] = max(0.0, self.spectrum_bands[i] * 0.55 - 2.0)
                        else:
                            self.spectrum_bands[i] = 0.0
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
                    if any_active:
                        self._check_transitions_locked()

                    sfx_duck_factor = 0.42 if (sfx_active and self.sfx_duck_music) else 1.0
                    bus_gain = max(
                        0.0,
                        min(1.5, self.master_volume * self.duck_multiplier * sfx_duck_factor),
                    )
                    mixed *= bus_gain

                    # Sofort-Soundeffekt (Jingle / SFX Overlay) darübermischen
                    if sfx_active and self.sfx_buffer is not None:
                        need = FRAMES_PER_CHUNK * CHANNELS
                        rem = len(self.sfx_buffer) - self.sfx_pos
                        take = min(need, rem)
                        sfx_gain = max(0.25, min(1.35, self.master_volume * 1.05))
                        mixed[:take] += self.sfx_buffer[self.sfx_pos : self.sfx_pos + take] * sfx_gain
                        self.sfx_pos += take
                        if self.sfx_pos >= len(self.sfx_buffer):
                            self.active_sfx_id = None
                            self.sfx_buffer = None
                            self.sfx_pos = 0

                    mixed = self._apply_eq_and_spectrum_locked(mixed)
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
        self.sync_settings(settings)
        if settings.get("auto_next_enabled", "true") == "false" or not tracks:
            return
        active = self.decks[self.active_idx]
        if not active.track:
            return
        nxt = self._pick_next_track(active.track, tracks, consume_planned=True)
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
