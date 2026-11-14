/**
 * Arena DJ Soundboard – Wettkampf-Musiksteuerung
 * Unterstützt iPad/iOS, Android & Desktop über Web Audio API (GainNode)
 * für butterweiche Fades, Talkover/Ducking und präzise Highlight-Cue-Points.
 */

const state = {
  categories: [],
  tracks: [],
  settings: {
    fade_in_duration: 1.5,
    fade_out_duration: 2.0,
    crossfade_duration: 4.0,
    ducking_volume: 0.2,
    ducking_fade: 0.6,
    master_volume: 0.85,
    auto_fade_enabled: true,
    auto_next_enabled: true,
    shuffle_enabled: false,
    crossfade_enabled: true,
    view_mode: "grid",
    design_theme: getTheme(),
    language: getLang(),
    panel_order: localStorage.getItem("arena_dj_panel_order") || "songs,fader,deck",
  },
  serverInfo: {
    lan_url: window.location.origin,
    magic_lan_url: window.location.origin,
  },
  authInfo: {
    auth_enabled: true,
    auth_require_on_localhost: false,
    access_token: "",
    initial_pin_hint: null,
    has_custom_password: false,
    is_localhost: false,
  },
  systemVersion: {
    git_available: false,
    local_short: "",
    local_date: "",
    local_subject: "",
  },
  activeCategory: "all",
  searchQuery: "",
  outputMode: localStorage.getItem("arena_dj_output_mode") || "server", // "server" | "local"
  serverAudioAvailable: true,
  serverCurrentTime: 0.0,
  serverEffectivePct: 85,
  isDraggingFader: false,
  isDraggingTrack: false,
  lastBoardSig: "",
  initialLoadDone: false,
  pendingResumeSnapshot: null,
  autoFollowEnabled: true,
  lastScrolledTrackId: null,
  shuffleHistory: [],
  plannedNextTrackId: null,
  serverNextTrackId: null,

  // Live Player State
  currentTrack: null,
  currentCue: null,
  isPlaying: false,
  isFadingOut: false,
  isCrossfading: false,
  manualStopOrFade: false,
  isTalkoverActive: false,
  duckMultiplier: 1.0, // 1.0 normal, z.B. 0.20 bei Talkover
  duckAnimationId: null,

  // Editor Modal State
  editingTrackId: null,
  editorCursorTime: 0.0,
  editorIsPlaying: false,
};

// ============================================================================
// DUAL-DECK AUDIO ENGINE (Deck A + Deck B für nahtlosen Crossfade & iPad Gain)
// ============================================================================
const SILENT_UNLOCK_WAV =
  "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA";

function createDeck(index) {
  const audio = new Audio();
  audio.preload = "auto";
  return {
    index,
    audio,
    gainNode: null,
    sourceConnected: false,
    trackVolume: 1.0,
    fadeGain: 0.0,
    animId: null,
  };
}

const decks = [createDeck(0), createDeck(1)];
let activeDeckIdx = 0;
let decksUnlocked = false;

function getActiveDeck() {
  return decks[activeDeckIdx];
}

function getActiveAudio() {
  return decks[activeDeckIdx].audio;
}

const editorAudio = new Audio();
editorAudio.preload = "auto";

let audioCtx = null;
let masterBusGain = null;

function ensureAudioContext() {
  if (!audioCtx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (AudioContextClass) {
      audioCtx = new AudioContextClass();
      masterBusGain = audioCtx.createGain();
      masterBusGain.connect(audioCtx.destination);

      decks.forEach((deck) => {
        try {
          deck.gainNode = audioCtx.createGain();
          deck.gainNode.gain.value = 0;
          deck.gainNode.connect(masterBusGain);
          const src = audioCtx.createMediaElementSource(deck.audio);
          src.connect(deck.gainNode);
          deck.sourceConnected = true;
        } catch (err) {
          console.warn(`WebAudio Deck ${deck.index} Fallback:`, err);
        }
      });
    }
  }
  if (audioCtx && audioCtx.state === "suspended") {
    audioCtx.resume();
  }

  // Beim ersten Fingertipp auf iPad/iPhone auch das zweite Deck stumm entsperren,
  // damit es später beim automatischen Liedwechsel ohne erneuten Touch starten darf!
  if (!decksUnlocked) {
    decksUnlocked = true;
    const inactive = decks[1 - activeDeckIdx];
    if (!inactive.audio.src) {
      inactive.fadeGain = 0;
      inactive.audio.src = SILENT_UNLOCK_WAV;
      inactive.audio
        .play()
        .then(() => {
          inactive.audio.pause();
          inactive.audio.removeAttribute("src");
        })
        .catch(() => {});
    }
  }
}

/**
 * Aktualisiert den Master-Bus (Master-Fader * Talkover) sowie beide Einzel-Decks
 */
function applyEffectiveVolume() {
  const master = state.settings.master_volume;
  const duckFactor = state.duckMultiplier;
  const busGain = Math.max(0, Math.min(1.5, master * duckFactor));

  if (masterBusGain && audioCtx) {
    masterBusGain.gain.setValueAtTime(busGain, audioCtx.currentTime);
  }

  decks.forEach((deck) => {
    const deckLevel = Math.max(0, Math.min(1.5, deck.trackVolume * deck.fadeGain));
    if (deck.sourceConnected && deck.gainNode && audioCtx) {
      deck.gainNode.gain.setValueAtTime(deckLevel, audioCtx.currentTime);
      deck.audio.volume = 1.0;
    } else {
      deck.audio.volume = Math.max(0, Math.min(1.0, busGain * deckLevel));
    }
  });

  // UI-Pegelanzeige im vertikalen Fader-Schlitz aktualisieren
  const peakDeckFade = Math.max(decks[0].fadeGain, decks[1].fadeGain, state.isPlaying ? 0 : 1);
  const displayPct = Math.round(master * duckFactor * peakDeckFade * 100);
  const effFillEl = document.getElementById("verticalEffectiveFill");
  if (effFillEl) {
    effFillEl.style.height = `${Math.max(0, Math.min(100, displayPct))}%`;
  }
  const infoEl = document.getElementById("effectiveVolInfo");
  if (infoEl) {
    const outPct = Math.round(master * duckFactor * 100);
    if (state.isTalkoverActive) {
      infoEl.textContent = t("eff_talkover", { pct: displayPct });
    } else if (state.isFadingOut) {
      infoEl.textContent = t("eff_fading_out", { pct: displayPct });
    } else if (state.isCrossfading) {
      infoEl.textContent = t("eff_crossfading", { pct: outPct });
    } else {
      infoEl.textContent = t("eff_output", { pct: outPct });
    }
  }
}

function cancelDeckFade(deck) {
  if (deck.animId) {
    cancelAnimationFrame(deck.animId);
    deck.animId = null;
  }
}

function cancelAllDeckFades() {
  decks.forEach(cancelDeckFade);
  state.isFadingOut = false;
  state.isCrossfading = false;
}

/**
 * Animiert die Lautstärke eines einzelnen Decks (optional mit Equal-Power-Kurve für Crossfades)
 */
function animateDeckGain(deck, fromVal, toVal, durationSec, curveType = "linear", onComplete) {
  cancelDeckFade(deck);
  if (durationSec <= 0.05) {
    deck.fadeGain = toVal;
    applyEffectiveVolume();
    if (onComplete) onComplete();
    return;
  }

  const startTime = performance.now();
  const durationMs = durationSec * 1000;

  function step(now) {
    const p = Math.min(1, (now - startTime) / durationMs);
    if (curveType === "equalIn") {
      deck.fadeGain = toVal * Math.sin(p * Math.PI * 0.5);
    } else if (curveType === "equalOut") {
      deck.fadeGain = fromVal * Math.cos(p * Math.PI * 0.5);
    } else {
      deck.fadeGain = fromVal + (toVal - fromVal) * p;
    }
    applyEffectiveVolume();

    if (p < 1) {
      deck.animId = requestAnimationFrame(step);
    } else {
      deck.animId = null;
      deck.fadeGain = toVal;
      applyEffectiveVolume();
      if (onComplete) onComplete();
    }
  }

  deck.animId = requestAnimationFrame(step);
}

// ============================================================================
// SERVER-TON vs. LOKALER GERÄTE-TON & RELOAD-SCHUTZ
// ============================================================================
const LOCAL_SNAPSHOT_KEY = "arena_dj_local_playback_v1";

function isServerMode() {
  return state.outputMode === "server" && state.serverAudioAvailable;
}

function setOutputMode(mode) {
  const nextMode = mode === "local" ? "local" : "server";
  if (nextMode === state.outputMode) return;

  // Wenn wir auf Server-Ton wechseln, lokalen Browser-Ton leise beenden
  if (nextMode === "server") {
    cancelAllDeckFades();
    decks.forEach((d) => {
      d.audio.pause();
      d.fadeGain = 0;
    });
    clearLocalPlaybackSnapshot();
    document.getElementById("localResumeBanner").classList.add("hidden");
  }

  state.outputMode = nextMode;
  localStorage.setItem("arena_dj_output_mode", nextMode);
  syncControlsWithSettings();
  if (nextMode === "server") {
    pollServerPlayerStatus();
  } else {
    state.isPlaying = !getActiveAudio().paused;
    updatePlayerUI();
    renderSoundboard();
  }
}

async function sendServerCommand(payload) {
  try {
    const res = await fetch("/api/player/command", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.player_status) {
        applyServerPlayerStatus(data.player_status);
      }
    }
  } catch (err) {
    console.warn("Server-Befehl fehlgeschlagen:", err);
  }
}

function applyServerPlayerStatus(ps) {
  if (!ps) return;
  if (typeof ps.audio_available === "boolean") {
    state.serverAudioAvailable = ps.audio_available;
  }
  if (!isServerMode()) return;

  const prevSig = `${state.isPlaying}:${state.currentTrack ? state.currentTrack.id : 0}:${
    state.currentCue ? state.currentCue.start_time : -1
  }`;

  state.isPlaying = Boolean(ps.is_playing);
  state.isFadingOut = Boolean(ps.is_fading_out);
  state.isCrossfading = Boolean(ps.is_crossfading);
  state.isTalkoverActive = Boolean(ps.is_talkover_active);
  state.serverCurrentTime = Number(ps.current_time || 0);
  state.serverEffectivePct = Number(ps.effective_volume_pct ?? 85);
  state.serverNextTrackId = ps.next_track_id ? Number(ps.next_track_id) : null;
  if (typeof ps.shuffle_enabled === "boolean" && ps.shuffle_enabled !== state.settings.shuffle_enabled) {
    state.settings.shuffle_enabled = ps.shuffle_enabled;
    syncControlsWithSettings();
  }

  if (ps.current_track_id) {
    const found = state.tracks.find((t) => t.id === ps.current_track_id);
    if (found) state.currentTrack = found;
  }
  if (ps.current_cue) {
    state.currentCue = ps.current_cue;
  }

  // Master-Fader mit anderen Geräten synchronisieren (außer man zieht ihn gerade selbst!)
  if (!state.isDraggingFader && typeof ps.master_volume === "number") {
    state.settings.master_volume = ps.master_volume;
    updateVerticalFaderUI(Math.round(ps.master_volume * 100));
  }

  // Talkover-Button synchronisieren
  const btnTalk = document.getElementById("btnTalkover");
  const badgeTalk = document.getElementById("talkoverBadge");
  const mobTalk = document.getElementById("mobTalkoverBtn");
  if (btnTalk && badgeTalk) {
    btnTalk.classList.toggle("active", state.isTalkoverActive);
    badgeTalk.textContent = state.isTalkoverActive ? t("badge_on") : t("badge_off");
  }
  if (mobTalk) {
    mobTalk.classList.toggle("active", state.isTalkoverActive);
  }

  // Effektiven Ausgangspegel im Fader-Schlitz anzeigen
  const effFillEl = document.getElementById("verticalEffectiveFill");
  if (effFillEl) {
    effFillEl.style.height = `${Math.max(0, Math.min(100, state.serverEffectivePct))}%`;
  }
  const infoEl = document.getElementById("effectiveVolInfo");
  if (infoEl) {
    if (state.isTalkoverActive) {
      infoEl.textContent = t("srv_eff_talkover", { pct: state.serverEffectivePct });
    } else if (state.isFadingOut) {
      infoEl.textContent = t("srv_eff_fading_out", { pct: state.serverEffectivePct });
    } else if (state.isCrossfading) {
      infoEl.textContent = t("srv_eff_crossfading", { pct: state.serverEffectivePct });
    } else {
      infoEl.textContent = t("srv_eff_output", { pct: state.serverEffectivePct });
    }
  }

  // Zeit & Wellenform aktualisieren
  const dur = Number(ps.duration || (state.currentTrack ? state.currentTrack.duration : 0) || 0);
  const cur = state.serverCurrentTime;
  document.getElementById("npCurrentTime").textContent = formatTime(cur, true);
  document.getElementById("npRemainingTime").textContent =
    dur > 0 ? `-${formatTime(Math.max(0, dur - cur), true)}` : "-0:00.0";
  document.getElementById("npDuration").textContent = formatTime(dur, false);
  drawNowPlayingWaveform(cur, dur);

  updatePlayerUI();

  const nextSig = `${state.isPlaying}:${state.currentTrack ? state.currentTrack.id : 0}:${
    state.currentCue ? state.currentCue.start_time : -1
  }`;
  if (prevSig !== nextSig) {
    renderSoundboard();
  }
}

async function pollServerPlayerStatus() {
  if (!isServerMode()) return;
  try {
    const res = await fetch("/api/player/status");
    if (res.ok) {
      const ps = await res.json();
      applyServerPlayerStatus(ps);
    }
  } catch (_) {}
}

function saveLocalPlaybackSnapshot() {
  if (isServerMode() || !state.isPlaying || !state.currentTrack || state.manualStopOrFade) {
    return;
  }
  const snap = {
    trackId: state.currentTrack.id,
    cue: state.currentCue,
    currentTime: getActiveAudio().currentTime || 0,
    savedAt: Date.now(),
  };
  try {
    sessionStorage.setItem(LOCAL_SNAPSHOT_KEY, JSON.stringify(snap));
  } catch (_) {}
}

function clearLocalPlaybackSnapshot() {
  try {
    sessionStorage.removeItem(LOCAL_SNAPSHOT_KEY);
  } catch (_) {}
}

async function tryRestoreLocalPlayback() {
  if (isServerMode()) return;
  let raw = null;
  try {
    raw = sessionStorage.getItem(LOCAL_SNAPSHOT_KEY);
  } catch (_) {}
  if (!raw) return;

  try {
    const snap = JSON.parse(raw);
    const ageSec = (Date.now() - Number(snap.savedAt || 0)) / 1000;
    if (ageSec > 30) {
      clearLocalPlaybackSnapshot();
      return;
    }
    const track = state.tracks.find((t) => t.id === snap.trackId);
    if (!track) return;

    const targetPos = Math.min(
      Math.max(0, (track.duration || 300) - 0.5),
      Number(snap.currentTime || 0) + Math.max(0, ageSec)
    );
    state.pendingResumeSnapshot = { track, cue: snap.cue, resumeAt: targetPos };

    // Versuchen, direkt nahtlos ohne Klick weiterzuspielen (klappt auf Desktop/Chrome sofort)
    const ok = await triggerTrackCue(track, snap.cue, { resumeAt: targetPos, silentCatch: true });
    if (!ok) {
      // Falls iOS Safari 1 Fingertipp verlangt -> grünen Sofort-Fortsetzen-Banner einblenden!
      const banner = document.getElementById("localResumeBanner");
      const txt = document.getElementById("localResumeText");
      txt.textContent = t("resume_dynamic", {
        title: track.title,
        time: formatTime(targetPos),
      });
      banner.classList.remove("hidden");
    } else {
      state.pendingResumeSnapshot = null;
    }
  } catch (_) {
    clearLocalPlaybackSnapshot();
  }
}

// ============================================================================
// PLAYBACK STEUERUNG (START, CROSSFADE, HIGHLIGHT-JUMP, FADE-OUT, STOP)
// ============================================================================
async function triggerTrackCue(track, cue, options = {}) {
  if (!editorAudio.paused) {
    editorAudio.pause();
  }

  if (isServerMode()) {
    const cues = track.cues || [];
    let cueIdx = -1;
    if (cue) {
      const foundIdx = cues.findIndex(
        (c) => (cue.id && c.id === cue.id) || c.start_time === cue.start_time
      );
      if (foundIdx >= 0) cueIdx = foundIdx;
    }
    await sendServerCommand({
      action: "trigger_cue",
      track_id: track.id,
      cue_index: cueIdx,
      active_category: state.activeCategory,
    });
    return true;
  }

  ensureAudioContext();

  const isAutoCrossfade = Boolean(options.isCrossfade);
  const startTime =
    typeof options.resumeAt === "number"
      ? options.resumeAt
      : cue
      ? Number(cue.start_time || 0)
      : 0;
  const cueWantsFade = options.resumeAt !== undefined ? false : cue ? Boolean(cue.fade_in) : true;

  const prevDeck = getActiveDeck();
  const prevWasPlaying = !prevDeck.audio.paused && prevDeck.fadeGain > 0.02;

  // Entscheiden, ob wir auf das zweite Deck wechseln und weich überblenden
  const useDualDeckCrossfade =
    prevWasPlaying && (isAutoCrossfade || (state.settings.crossfade_enabled && state.settings.auto_fade_enabled));

  let targetDeck = prevDeck;
  let fadeInSec = 0.05;
  let fadeCurveIn = "linear";

  if (useDualDeckCrossfade) {
    const xfadeDuration = isAutoCrossfade
      ? Number(options.crossfadeSec || state.settings.crossfade_duration || 4.0)
      : cueWantsFade
      ? Number(state.settings.fade_in_duration || 1.5)
      : 0.3;

    // Altes Deck sanft im Hintergrund ausblenden und danach pausieren
    const outgoingDeck = prevDeck;
    const outgoingStartGain = outgoingDeck.fadeGain;
    state.isCrossfading = true;

    animateDeckGain(outgoingDeck, outgoingStartGain, 0.0, xfadeDuration, "equalOut", () => {
      outgoingDeck.audio.pause();
      if (activeDeckIdx !== outgoingDeck.index) {
        state.isCrossfading = false;
        applyEffectiveVolume();
        updatePlayerUI();
      }
    });

    // Neues Deck aktivieren
    activeDeckIdx = 1 - activeDeckIdx;
    targetDeck = getActiveDeck();
    cancelDeckFade(targetDeck);
    fadeInSec = cueWantsFade || isAutoCrossfade ? xfadeDuration : 0.05;
    fadeCurveIn = isAutoCrossfade ? "equalIn" : "linear";
  } else {
    // Kein Crossfade nötig: anderes Deck sicherheitshalber stoppen
    const otherDeck = decks[1 - activeDeckIdx];
    cancelDeckFade(otherDeck);
    otherDeck.fadeGain = 0;
    otherDeck.audio.pause();
    cancelDeckFade(targetDeck);

    const shouldFadeIn = state.settings.auto_fade_enabled && cueWantsFade;
    fadeInSec = shouldFadeIn ? Number(state.settings.fade_in_duration || 1.5) : 0.05;
  }

  state.currentTrack = track;
  state.currentCue = cue || {
    id: null,
    label: t("np_from_start_cue"),
    start_time: 0,
    end_time: null,
  };
  state.manualStopOrFade = false;
  state.isFadingOut = false;

  if (track && track.id) {
    state.shuffleHistory.push(track.id);
    if (state.shuffleHistory.length > 250) {
      state.shuffleHistory = state.shuffleHistory.slice(-250);
    }
  }
  state.plannedNextTrackId = null;

  targetDeck.trackVolume = track.volume || 1.0;
  targetDeck.fadeGain = fadeInSec > 0.06 ? 0.01 : 1.0;
  applyEffectiveVolume();

  if (!targetDeck.audio.src || !targetDeck.audio.src.endsWith(track.url)) {
    targetDeck.audio.src = track.url;
  }
  targetDeck.audio.loop = Boolean(track.loop);

  try {
    targetDeck.audio.currentTime = startTime;
  } catch (_) {
    targetDeck.audio.addEventListener(
      "loadedmetadata",
      () => {
        try {
          targetDeck.audio.currentTime = startTime;
        } catch (_) {}
      },
      { once: true }
    );
  }

  try {
    await targetDeck.audio.play();
    state.isPlaying = true;
    document.getElementById("localResumeBanner").classList.add("hidden");
    saveLocalPlaybackSnapshot();
    if (fadeInSec > 0.06) {
      animateDeckGain(targetDeck, 0.01, 1.0, fadeInSec, fadeCurveIn, () => {
        state.isCrossfading = false;
        updatePlayerUI();
      });
    } else {
      targetDeck.fadeGain = 1.0;
      applyEffectiveVolume();
    }
    updatePlayerUI();
    renderSoundboard();
    return true;
  } catch (err) {
    if (!options.silentCatch) {
      console.error("Fehler beim Abspielen:", err);
    }
    return false;
  }
}

function getCandidateTrackPool() {
  if (!state.currentTrack || state.tracks.length === 0) return [];
  const visible = getFilteredTracks();
  if (visible.length > 0 && visible.some((tr) => tr.id === state.currentTrack.id)) {
    return visible;
  }
  const sameCat = state.tracks.filter((tr) => tr.category_id === state.currentTrack.category_id);
  if (sameCat.length > 0 && sameCat.some((tr) => tr.id === state.currentTrack.id)) {
    return sameCat;
  }
  return state.tracks;
}

function getNextTrack(consumePlanned = false) {
  if (!state.currentTrack || state.tracks.length === 0) return null;

  if (isServerMode() && state.serverNextTrackId && !consumePlanned) {
    const srvNext = state.tracks.find((tr) => tr.id === state.serverNextTrackId);
    if (srvNext) return srvNext;
  }

  const pool = getCandidateTrackPool();
  if (pool.length === 0) return null;

  if (state.settings.shuffle_enabled) {
    if (pool.length === 1) return pool[0];

    if (state.plannedNextTrackId !== null) {
      const planned = pool.find(
        (tr) => tr.id === state.plannedNextTrackId && tr.id !== state.currentTrack.id
      );
      if (planned) {
        if (consumePlanned) state.plannedNextTrackId = null;
        return planned;
      }
    }

    const candidates = pool.filter((tr) => tr.id !== state.currentTrack.id);
    const recentWindow = Math.max(0, pool.length - 1);
    const recentSet = new Set(
      recentWindow > 0 ? state.shuffleHistory.slice(-recentWindow) : []
    );
    const fresh = candidates.filter((tr) => !recentSet.has(tr.id));
    const bucket = fresh.length > 0 ? fresh : candidates;
    const chosen = bucket[Math.floor(Math.random() * bucket.length)];
    state.plannedNextTrackId = consumePlanned ? null : chosen.id;
    return chosen;
  }

  const idx = pool.findIndex((tr) => tr.id === state.currentTrack.id);
  if (idx !== -1) {
    return pool[(idx + 1) % pool.length];
  }
  return pool[0];
}

function playNextTrack(options = {}) {
  if (isServerMode()) {
    sendServerCommand({ action: "skip_next", active_category: state.activeCategory });
    return;
  }
  const nextTrack = getNextTrack(true);
  if (!nextTrack) return;
  triggerTrackCue(nextTrack, null, options);
}

function togglePlayPause() {
  if (isServerMode()) {
    sendServerCommand({ action: "toggle_play_pause" });
    return;
  }

  ensureAudioContext();
  if (!state.currentTrack) {
    const visible = getFilteredTracks();
    const startPool = visible.length > 0 ? visible : state.tracks;
    if (startPool.length > 0) {
      const firstTrack = state.settings.shuffle_enabled
        ? startPool[Math.floor(Math.random() * startPool.length)]
        : startPool[0];
      triggerTrackCue(firstTrack, null);
    }
    return;
  }

  const activeDeck = getActiveDeck();
  if (activeDeck.audio.paused) {
    state.manualStopOrFade = false;
    const fadeSec = state.settings.auto_fade_enabled
      ? Number(state.settings.fade_in_duration || 1.2)
      : 0.05;
    activeDeck.fadeGain = 0.05;
    applyEffectiveVolume();
    activeDeck.audio.play().then(() => {
      state.isPlaying = true;
      saveLocalPlaybackSnapshot();
      animateDeckGain(activeDeck, 0.05, 1.0, fadeSec, "linear");
      updatePlayerUI();
      renderSoundboard();
    });
  } else {
    state.manualStopOrFade = true;
    clearLocalPlaybackSnapshot();
    cancelAllDeckFades();
    decks.forEach((d) => d.audio.pause());
    state.isPlaying = false;
    updatePlayerUI();
    renderSoundboard();
  }
}

function triggerSmoothFadeOut(advanceToNext = false) {
  if (isServerMode()) {
    sendServerCommand({ action: "fade_out" });
    return;
  }

  const activeDeck = getActiveDeck();
  if (!state.currentTrack || activeDeck.audio.paused) return;
  if (!advanceToNext) {
    state.manualStopOrFade = true;
    clearLocalPlaybackSnapshot();
  }
  const fadeOutSec = Number(state.settings.fade_out_duration || 2.0);
  state.isFadingOut = true;
  state.isCrossfading = false;
  updatePlayerUI();

  const otherDeck = decks[1 - activeDeckIdx];
  if (!otherDeck.audio.paused) {
    animateDeckGain(otherDeck, otherDeck.fadeGain, 0.0, fadeOutSec, "linear", () => {
      otherDeck.audio.pause();
    });
  }

  animateDeckGain(activeDeck, activeDeck.fadeGain, 0.0, fadeOutSec, "linear", () => {
    activeDeck.audio.pause();
    state.isPlaying = false;
    state.isFadingOut = false;
    activeDeck.fadeGain = 1.0;
    applyEffectiveVolume();

    if (advanceToNext && !state.manualStopOrFade && state.settings.auto_next_enabled) {
      playNextTrack();
    } else {
      updatePlayerUI();
      renderSoundboard();
    }
  });
}

function stopImmediate() {
  if (isServerMode()) {
    sendServerCommand({ action: "stop" });
    return;
  }

  state.manualStopOrFade = true;
  clearLocalPlaybackSnapshot();
  cancelAllDeckFades();
  decks.forEach((d) => {
    d.audio.pause();
    d.fadeGain = 0;
  });
  getActiveDeck().fadeGain = 1.0;
  state.isPlaying = false;
  applyEffectiveVolume();
  updatePlayerUI();
  renderSoundboard();
}

function toggleTalkover() {
  if (isServerMode()) {
    sendServerCommand({ action: "talkover", active: !state.isTalkoverActive });
    return;
  }

  ensureAudioContext();
  state.isTalkoverActive = !state.isTalkoverActive;
  const btn = document.getElementById("btnTalkover");
  const badge = document.getElementById("talkoverBadge");
  const mobTalk = document.getElementById("mobTalkoverBtn");
  if (state.isTalkoverActive) {
    btn.classList.add("active");
    badge.textContent = t("badge_on");
  } else {
    btn.classList.remove("active");
    badge.textContent = t("badge_off");
  }
  if (mobTalk) mobTalk.classList.toggle("active", state.isTalkoverActive);

  const fromDuck = state.duckMultiplier;
  const toDuck = state.isTalkoverActive ? Number(state.settings.ducking_volume || 0.2) : 1.0;
  const durationMs = Math.max(50, Number(state.settings.ducking_fade || 0.6) * 1000);

  if (state.duckAnimationId) {
    cancelAnimationFrame(state.duckAnimationId);
  }

  const start = performance.now();
  function stepDuck(now) {
    const progress = Math.min(1, (now - start) / durationMs);
    state.duckMultiplier = fromDuck + (toDuck - fromDuck) * progress;
    applyEffectiveVolume();
    if (progress < 1) {
      state.duckAnimationId = requestAnimationFrame(stepDuck);
    } else {
      state.duckAnimationId = null;
    }
  }
  state.duckAnimationId = requestAnimationFrame(stepDuck);
}

// ============================================================================
// AUDIO EVENTS & ZEIT-ÜBERWACHUNG (INKL. CROSSFADE, AUTO-NEXT & CUE END-TIME)
// ============================================================================
decks.forEach((deck) => {
  deck.audio.addEventListener("ended", () => {
    if (isServerMode() || deck.index !== activeDeckIdx) return;

    state.isPlaying = false;
    state.isFadingOut = false;
    state.isCrossfading = false;
    deck.fadeGain = 1.0;

    if (!state.manualStopOrFade && state.settings.auto_next_enabled && state.tracks.length > 0) {
      playNextTrack();
      return;
    }

    clearLocalPlaybackSnapshot();
    updatePlayerUI();
    renderSoundboard();
  });
});

let _lastSnapSave = 0;

function updateLiveLoop() {
  if (!isServerMode()) {
    const activeDeck = getActiveDeck();
    const activeAudio = activeDeck.audio;

    if (state.currentTrack && !activeAudio.paused) {
      const cur = activeAudio.currentTime || 0;
      const dur = activeAudio.duration || state.currentTrack.duration || 0;
      const hasCueEnd =
        state.currentCue &&
        state.currentCue.end_time &&
        state.currentCue.end_time > state.currentCue.start_time;

      const nowMs = performance.now();
      if (nowMs - _lastSnapSave > 350) {
        _lastSnapSave = nowMs;
        saveLocalPlaybackSnapshot();
      }

      if (state.currentTrack.loop) {
        if (hasCueEnd && cur >= state.currentCue.end_time) {
          activeAudio.currentTime = Number(state.currentCue.start_time || 0);
        }
      } else if (!state.manualStopOrFade && !state.isFadingOut && !state.isCrossfading) {
        const effectiveEnd = hasCueEnd ? Number(state.currentCue.end_time) : dur;

        if (effectiveEnd > 0) {
          const remaining = effectiveEnd - cur;

          if (state.settings.auto_next_enabled && state.settings.crossfade_enabled && state.tracks.length > 0) {
            const configuredXfade = Number(state.settings.crossfade_duration || 4.0);
            const xfadeWindow = Math.min(configuredXfade, Math.max(1.0, effectiveEnd * 0.45));
            if (remaining <= xfadeWindow && remaining > 0.15 && cur > 0.4) {
              playNextTrack({ isCrossfade: true, crossfadeSec: remaining });
            }
          } else if (hasCueEnd) {
            const fadeOutSec = Math.min(1.5, Number(state.settings.fade_out_duration || 1.5));
            if (remaining <= fadeOutSec) {
              triggerSmoothFadeOut(true);
            }
          }
        }
      }

      document.getElementById("npCurrentTime").textContent = formatTime(cur, true);
      document.getElementById("npRemainingTime").textContent =
        dur > 0 ? `-${formatTime(Math.max(0, dur - cur), true)}` : "-0:00.0";
      document.getElementById("npDuration").textContent = formatTime(dur, false);

      drawNowPlayingWaveform(cur, dur);
    }
  }
  requestAnimationFrame(updateLiveLoop);
}

// ============================================================================
// API & STATE SYNCHRONISATION
// ============================================================================
async function loadStateFromServer() {
  const res = await fetch("/api/state");
  if (res.status === 401) {
    window.location.reload();
    return;
  }
  const data = await res.json();
  state.categories = data.categories || [];
  state.tracks = data.tracks || [];
  state.serverInfo = data.server_info || { lan_url: window.location.origin };
  if (data.auth_info) {
    state.authInfo = data.auth_info;
  }
  if (data.system_version) {
    state.systemVersion = data.system_version;
  }

  if (data.settings) {
    state.settings.fade_in_duration = parseFloat(data.settings.fade_in_duration ?? 1.5);
    state.settings.fade_out_duration = parseFloat(data.settings.fade_out_duration ?? 2.0);
    state.settings.crossfade_duration = parseFloat(data.settings.crossfade_duration ?? 4.0);
    state.settings.ducking_volume = parseFloat(data.settings.ducking_volume ?? 0.2);
    state.settings.ducking_fade = parseFloat(data.settings.ducking_fade ?? 0.6);
    if (!state.isDraggingFader) {
      state.settings.master_volume = parseFloat(data.settings.master_volume ?? 0.85);
    }
    state.settings.auto_fade_enabled = data.settings.auto_fade_enabled !== "false";
    state.settings.auto_next_enabled = data.settings.auto_next_enabled !== "false";
    state.settings.shuffle_enabled = data.settings.shuffle_enabled === "true";
    state.settings.crossfade_enabled = data.settings.crossfade_enabled !== "false";
    state.settings.view_mode = data.settings.view_mode === "list" ? "list" : "grid";
    let themeOrLangChanged = false;
    if (data.settings.design_theme && data.settings.design_theme !== getTheme()) {
      setThemeCode(data.settings.design_theme);
      state.settings.design_theme = getTheme();
      themeOrLangChanged = true;
    } else {
      setThemeCode(getTheme());
      state.settings.design_theme = getTheme();
    }
    if (data.settings.language && data.settings.language !== getLang()) {
      setLangCode(data.settings.language);
      state.settings.language = getLang();
      themeOrLangChanged = true;
    } else {
      state.settings.language = getLang();
    }
    if (themeOrLangChanged) {
      applyStaticTranslations();
    }
    if (data.settings.panel_order) {
      state.settings.panel_order = data.settings.panel_order;
      localStorage.setItem("arena_dj_panel_order", data.settings.panel_order);
    }
  }

  applyPanelOrder();

  if (data.player_status && typeof data.player_status.audio_available === "boolean") {
    state.serverAudioAvailable = data.player_status.audio_available;
    if (!state.serverAudioAvailable && state.outputMode === "server") {
      state.outputMode = "local";
    }
  }

  if (state.currentTrack) {
    const updated = state.tracks.find((t) => t.id === state.currentTrack.id);
    if (updated) {
      state.currentTrack = updated;
      getActiveDeck().trackVolume = updated.volume || 1.0;
      getActiveAudio().loop = Boolean(updated.loop);
    }
  }

  syncControlsWithSettings();
  renderCategories();
  renderSoundboard();

  if (isServerMode() && data.player_status) {
    applyServerPlayerStatus(data.player_status);
  } else {
    updatePlayerUI();
  }

  if (!state.initialLoadDone) {
    state.initialLoadDone = true;
    tryRestoreLocalPlayback();
  }
}

function updateVerticalFaderUI(volPct) {
  const clamped = Math.max(0, Math.min(100, Math.round(volPct)));
  const valLabel = document.getElementById("masterVolumeValue");
  const mobPct = document.getElementById("mobFaderPct");
  const thumb = document.getElementById("verticalFaderThumb");
  const fill = document.getElementById("verticalFaderFill");
  const track = document.getElementById("verticalFaderTrack");

  if (valLabel) valLabel.textContent = `${clamped}%`;
  if (mobPct) mobPct.textContent = `${clamped}%`;
  if (thumb) thumb.style.bottom = `${clamped}%`;
  if (fill) fill.style.height = `${clamped}%`;
  if (track) track.setAttribute("aria-valuenow", String(clamped));

  document.querySelectorAll(".quick-vol-btn").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.vol) === clamped);
  });
}

function syncControlsWithSettings() {
  const volPct = Math.round(state.settings.master_volume * 100);
  updateVerticalFaderUI(volPct);

  const serverBtn = document.getElementById("outServerBtn");
  const localBtn = document.getElementById("outLocalBtn");
  if (serverBtn && localBtn) {
    serverBtn.disabled = !state.serverAudioAvailable;
    serverBtn.classList.toggle("active", isServerMode());
    localBtn.classList.toggle("active", !isServerMode());
  }

  const isList = state.settings.view_mode === "list";
  document.getElementById("viewGridBtn").classList.toggle("active", !isList);
  document.getElementById("viewListBtn").classList.toggle("active", isList);

  document.getElementById("autoFadeToggle").checked = state.settings.auto_fade_enabled;
  document.getElementById("autoNextToggle").checked = state.settings.auto_next_enabled;
  const shuffleToggleEl = document.getElementById("shuffleToggle");
  if (shuffleToggleEl) {
    shuffleToggleEl.checked = Boolean(state.settings.shuffle_enabled);
  }
  const shuffleQuickBtn = document.getElementById("shuffleQuickBtn");
  if (shuffleQuickBtn) {
    shuffleQuickBtn.classList.toggle("active", Boolean(state.settings.shuffle_enabled));
    shuffleQuickBtn.title = state.settings.shuffle_enabled
      ? t("shuffle_on_title")
      : t("shuffle_off_title");
  }
  document.getElementById("crossfadeToggle").checked = state.settings.crossfade_enabled;
  document.getElementById("autoFadeInfo").textContent = `${state.settings.fade_in_duration}s`;
  document.getElementById("crossfadeInfo").textContent = `${state.settings.crossfade_duration}s`;
  document.getElementById("fadeOutSubLabel").textContent = t("fade_out_sub", {
    sec: state.settings.fade_out_duration,
  });
  document.getElementById("talkoverDesc").textContent = t("talkover_desc", {
    pct: Math.round(state.settings.ducking_volume * 100),
  });
  const badgeTalk = document.getElementById("talkoverBadge");
  if (badgeTalk) {
    badgeTalk.textContent = state.isTalkoverActive ? t("badge_on") : t("badge_off");
  }
  const autoFollowBtn = document.getElementById("autoFollowBtn");
  if (autoFollowBtn) {
    autoFollowBtn.title = state.autoFollowEnabled
      ? t("autofollow_on_title")
      : t("autofollow_off_title");
  }

  document.querySelectorAll("[data-lang-select]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.langSelect === getLang());
  });
  document.querySelectorAll("[data-theme-select]").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.themeSelect === getTheme());
  });

  if (!isServerMode()) {
    applyEffectiveVolume();
  }
}

async function setViewMode(mode) {
  const cleanMode = mode === "list" ? "list" : "grid";
  state.settings.view_mode = cleanMode;
  syncControlsWithSettings();
  renderSoundboard();
  await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view_mode: cleanMode }),
  });
}

async function setShuffleEnabled(enabled) {
  const nextVal = Boolean(enabled);
  state.settings.shuffle_enabled = nextVal;
  state.plannedNextTrackId = null;
  syncControlsWithSettings();
  updatePlayerUI();

  await fetch("/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ shuffle_enabled: String(nextVal) }),
  });
  if (isServerMode()) {
    await pollServerPlayerStatus();
  }
}

async function toggleTrackLoop(trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;
  const nextLoop = !Boolean(track.loop);
  track.loop = nextLoop;

  if (state.currentTrack && state.currentTrack.id === trackId) {
    state.currentTrack.loop = nextLoop;
    getActiveAudio().loop = nextLoop;
  }

  renderSoundboard();
  updatePlayerUI();

  await fetch(`/api/tracks/${trackId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loop: nextLoop }),
  });
}

// ============================================================================
// UI RENDERING: KATEGORIEN & SOUNDBOARD KARTEN
// ============================================================================
function renderCategories() {
  const select = document.getElementById("categorySelect");
  if (!select) return;

  if (
    state.activeCategory !== "all" &&
    !state.categories.some((c) => c.id === state.activeCategory)
  ) {
    state.activeCategory = "all";
  }

  const totalCount = state.tracks.length;
  const isStudio = getTheme() === "studio";
  let html = `<option value="all">${escapeHtml(t("cat_all"))} (${totalCount})</option>`;

  for (const cat of state.categories) {
    const count = state.tracks.filter((t) => t.category_id === cat.id).length;
    const catLabel = getCategoryDisplayName(cat);
    const prefix = isStudio ? "" : `${escapeHtml(cat.icon)} `;
    html += `<option value="${escapeHtml(cat.id)}">${prefix}${escapeHtml(catLabel)} (${count})</option>`;
  }

  if (select.dataset.renderedHtml !== html) {
    select.innerHTML = html;
    select.dataset.renderedHtml = html;
  }
  select.value = state.activeCategory;
  select.classList.toggle("is-filtered", state.activeCategory !== "all");
}

function getFilteredTracks() {
  const q = state.searchQuery.trim().toLowerCase();
  return state.tracks.filter((track) => {
    if (state.activeCategory !== "all" && track.category_id !== state.activeCategory) {
      return false;
    }
    if (!q) return true;
    const inTitle = track.title.toLowerCase().includes(q);
    const inArtist = (track.artist || "").toLowerCase().includes(q);
    const inCues = (track.cues || []).some((c) => c.label.toLowerCase().includes(q));
    return inTitle || inArtist || inCues;
  });
}

const LOOP_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`;
const EDIT_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="4" y1="21" x2="4" y2="14"></line><line x1="4" y1="10" x2="4" y2="3"></line><line x1="12" y1="21" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="3"></line><line x1="20" y1="21" x2="20" y2="16"></line><line x1="20" y1="12" x2="20" y2="3"></line><line x1="1" y1="14" x2="7" y2="14"></line><line x1="9" y1="8" x2="15" y2="8"></line><line x1="17" y1="16" x2="23" y2="16"></line></svg>`;

function renderSoundboard() {
  if (state.isDraggingTrack) return;
  const grid = document.getElementById("soundboardGrid");
  const tracks = getFilteredTracks();
  const isListMode = state.settings.view_mode === "list";
  const isStudio = getTheme() === "studio";
  const canDragTracks = !state.searchQuery.trim();

  grid.classList.toggle("list-mode", isListMode);

  if (tracks.length === 0) {
    grid.innerHTML = `
      <div class="track-card" style="grid-column: 1 / -1; text-align: center; padding: 36px;">
        <h3>${escapeHtml(t("empty_tracks_title"))}</h3>
        <p style="color: var(--text-muted); margin-top: 6px;">
          ${escapeHtml(t("empty_tracks_sub"))}
        </p>
      </div>
    `;
    return;
  }

  if (isListMode) {
    grid.innerHTML = tracks
      .map((track) => {
        const isTrackPlaying =
          state.isPlaying && state.currentTrack && state.currentTrack.id === track.id;
        const cues = track.cues || [];

        const numsHtml = cues
          .map((cue, idx) => {
            const isCueActive =
              isTrackPlaying &&
              state.currentCue &&
              cue.id &&
              state.currentCue.id === cue.id;
            const bg = cue.color || track.color || "#f97316";
            const tip = t("cue_btn_tip", {
              num: idx + 1,
              label: cue.label,
              time: formatTime(cue.start_time),
            });
            return `
              <button
                type="button"
                class="cue-num-btn ${isCueActive ? "active-cue" : ""}"
                style="--cue-accent: ${bg}; background: linear-gradient(145deg, ${bg}ee, ${bg}88);"
                data-track-id="${track.id}"
                data-cue-index="${idx}"
                title="${escapeHtml(tip)}"
              >
                ${idx + 1}
              </button>
            `;
          })
          .join("");

        const mainColor = track.color || "#f97316";
        const loopTip = track.loop ? t("loop_active_title") : t("loop_inactive_title");
        const playSymbol = isTrackPlaying ? (isStudio ? "■" : "🔊") : "▶";
        return `
          <div class="track-list-row ${isTrackPlaying ? "is-playing" : ""}" data-track-id="${track.id}">
            <div class="list-track-main">
              ${
                canDragTracks
                  ? `<span class="track-drag-handle" title="${escapeHtml(t("track_drag_title"))}">⠿</span>`
                  : ""
              }
              <button
                type="button"
                class="list-quick-play cue-trigger-btn"
                style="--track-accent: ${mainColor}; background: ${mainColor};"
                data-track-id="${track.id}"
                data-cue-index="-1"
                title="${escapeHtml(t("play_from_start_title"))}"
              >
                ${playSymbol}
              </button>
              <div class="list-title-block">
                <div class="list-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
                <div class="list-sub">${escapeHtml(track.artist || t("default_artist"))} • ${formatTime(track.duration)}</div>
              </div>
            </div>

            <div class="list-cues-wrap">
              ${numsHtml}
            </div>

            <div class="list-actions">
              <button
                type="button"
                class="btn-loop-toggle ${track.loop ? "active" : ""}"
                data-toggle-loop="${track.id}"
                title="${escapeHtml(loopTip)}"
                aria-label="${escapeHtml(t("loop_aria"))}"
              >
                ${LOOP_ICON_SVG}
              </button>
              <button type="button" class="btn-edit-cues" data-edit-track="${track.id}" title="${escapeHtml(t("edit_cues_title"))}" aria-label="${escapeHtml(t("edit_cues_title"))}">
                ${EDIT_ICON_SVG}
              </button>
            </div>
          </div>
        `;
      })
      .join("");
  } else {
    grid.innerHTML = tracks
      .map((track) => {
        const isTrackPlaying =
          state.isPlaying && state.currentTrack && state.currentTrack.id === track.id;
        const cues = track.cues || [];

        const numsHtml = cues
          .map((cue, idx) => {
            const isCueActive =
              isTrackPlaying &&
              state.currentCue &&
              cue.id &&
              state.currentCue.id === cue.id;
            const bg = cue.color || track.color || "#f97316";
            const tip = t("cue_btn_tip", {
              num: idx + 1,
              label: cue.label,
              time: formatTime(cue.start_time),
            });

            return `
              <button
                type="button"
                class="cue-num-btn ${isCueActive ? "active-cue" : ""}"
                style="--cue-accent: ${bg}; background: linear-gradient(145deg, ${bg}ee, ${bg}88);"
                data-track-id="${track.id}"
                data-cue-index="${idx}"
                title="${escapeHtml(tip)}"
              >
                ${idx + 1}
              </button>
            `;
          })
          .join("");

        const mainColor = track.color || "#f97316";
        const loopTip = track.loop ? t("loop_active_title") : t("loop_inactive_title");
        const playSymbol = isTrackPlaying ? (isStudio ? "■" : "🔊") : "▶";
        return `
          <article class="track-card ${isTrackPlaying ? "is-playing" : ""}" data-track-id="${track.id}">
            <div class="track-card-header">
              ${
                canDragTracks
                  ? `<span class="track-drag-handle" title="${escapeHtml(t("track_drag_title"))}">⠿</span>`
                  : ""
              }
              <button
                type="button"
                class="list-quick-play cue-trigger-btn"
                style="--track-accent: ${mainColor}; background: ${mainColor};"
                data-track-id="${track.id}"
                data-cue-index="-1"
                title="${escapeHtml(t("play_from_start_title"))}"
              >
                ${playSymbol}
              </button>
              <div class="track-title-wrap">
                <div class="track-title" title="${escapeHtml(track.title)}">${escapeHtml(track.title)}</div>
                <div class="track-meta-sub">
                  <span>${escapeHtml(track.artist || t("default_artist"))}</span>
                  <span>• ${formatTime(track.duration)}</span>
                </div>
              </div>
              <div class="card-actions-right">
                <button
                  type="button"
                  class="btn-loop-toggle ${track.loop ? "active" : ""}"
                  data-toggle-loop="${track.id}"
                  title="${escapeHtml(loopTip)}"
                  aria-label="${escapeHtml(t("loop_aria"))}"
                >
                  ${LOOP_ICON_SVG}
                </button>
                <button type="button" class="btn-edit-cues" data-edit-track="${track.id}" title="${escapeHtml(t("edit_cues_title"))}" aria-label="${escapeHtml(t("edit_cues_title"))}">
                  ${EDIT_ICON_SVG}
                </button>
              </div>
            </div>

            <div class="card-waveform-wrap" data-edit-track="${track.id}" title="${escapeHtml(t("edit_waveform_title"))}">
              <canvas class="card-waveform-canvas" id="cardWf_${track.id}" width="320" height="44"></canvas>
            </div>

            ${cues.length > 0 ? `<div class="cue-pads-grid">${numsHtml}</div>` : ""}
          </article>
        `;
      })
      .join("");
  }

  // Event-Listener für nummerierte Highlight-Buttons (1, 2, 3...) & Start-Buttons (▶)
  grid.querySelectorAll(".cue-num-btn, .cue-trigger-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const trackId = Number(btn.dataset.trackId);
      const cueIdx = Number(btn.dataset.cueIndex);
      const track = state.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const cue =
        cueIdx >= 0 && track.cues && track.cues[cueIdx] ? track.cues[cueIdx] : null;
      triggerTrackCue(track, cue);
    });
  });

  // Event-Listener für direkten Endlosschleifen-Schalter (🔁)
  grid.querySelectorAll("[data-toggle-loop]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleTrackLoop(Number(btn.dataset.toggleLoop));
    });
  });

  // Event-Listener für "Highlights bearbeiten"
  grid.querySelectorAll("[data-edit-track]").forEach((el) => {
    el.addEventListener("click", () => {
      openCueEditor(Number(el.dataset.editTrack));
    });
  });

  // Drag & Drop zum Umsortieren der Lieder untereinander
  if (canDragTracks) {
    bindTrackDragAndDrop(grid);
  }

  // Mini-Waveforms zeichnen (in der Kachel-Ansicht)
  if (!isListMode) {
    tracks.forEach((track) => {
      const canvas = document.getElementById(`cardWf_${track.id}`);
      if (canvas) {
        drawMiniWaveform(canvas, track);
      }
    });
  }

  // Automatisches Mitlaufen der Liste beim Titelwechsel!
  if (state.isPlaying && state.currentTrack) {
    if (state.lastScrolledTrackId !== state.currentTrack.id) {
      state.lastScrolledTrackId = state.currentTrack.id;
      scrollActiveTrackIntoView(false);
    }
  } else if (!state.isPlaying) {
    state.lastScrolledTrackId = null;
  }
}

function scrollActiveTrackIntoView(force = false) {
  if (!force && !state.autoFollowEnabled) return;
  if (!state.currentTrack) return;

  const grid = document.getElementById("soundboardGrid");
  const viewport = document.getElementById("songsScrollViewport");
  if (!grid) return;

  const activeEl = grid.querySelector(`[data-track-id="${state.currentTrack.id}"]`);
  if (!activeEl) return;

  if (viewport && window.innerWidth > 980) {
    // Sanftes Zentrieren direkt innerhalb des eigenen Lieder-Scrollbereichs
    const vpRect = viewport.getBoundingClientRect();
    const elRect = activeEl.getBoundingClientRect();
    const currentOffset = elRect.top - vpRect.top + viewport.scrollTop;
    const targetScrollTop = Math.max(
      0,
      currentOffset - vpRect.height / 2 + elRect.height / 2
    );
    viewport.scrollTo({ top: targetScrollTop, behavior: "smooth" });
  } else {
    activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function applyPanelOrder() {
  const workspace = document.getElementById("mainWorkspace");
  if (!workspace) return;
  const order = (state.settings.panel_order || "songs,fader,deck")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const currentIds = Array.from(workspace.querySelectorAll(".cockpit-panel")).map(
    (el) => el.dataset.panelId
  );
  if (currentIds.join(",") === order.join(",")) return;

  order.forEach((panelId) => {
    const el = workspace.querySelector(`.cockpit-panel[data-panel-id="${panelId}"]`);
    if (el) {
      workspace.appendChild(el);
    }
  });
}

function updatePlayerUI() {
  const onAirBadge = document.getElementById("onAirBadge");
  const deckDot = document.getElementById("deckDot");
  const deckStatusText = document.getElementById("deckStatusText");
  const npTitle = document.getElementById("npTitle");
  const npCue = document.getElementById("npCue");
  const btnPlayPause = document.getElementById("btnPlayPause");
  const btnFadeOut = document.getElementById("btnFadeOut");
  const btnStop = document.getElementById("btnStopImmediate");
  const playPauseIcon = document.getElementById("playPauseIcon");
  const playPauseLabel = document.getElementById("playPauseLabel");
  const btnNpLoop = document.getElementById("btnNowPlayingLoop");

  const hasTrack = Boolean(state.currentTrack);
  btnPlayPause.disabled = !hasTrack && state.tracks.length === 0;
  btnFadeOut.disabled = !state.isPlaying;
  btnStop.disabled = !state.isPlaying;
  btnNpLoop.disabled = !hasTrack;

  if (hasTrack && state.currentTrack.loop) {
    btnNpLoop.classList.add("active");
    btnNpLoop.textContent = t("np_loop_on");
  } else {
    btnNpLoop.classList.remove("active");
    btnNpLoop.textContent = t("np_loop_off");
  }

  if (state.isPlaying) {
    onAirBadge.textContent = "ON AIR";
    onAirBadge.classList.add("on-air");
    deckDot.className =
      "deck-status-dot " + (state.isFadingOut || state.isCrossfading ? "fading" : "playing");
    deckStatusText.textContent = state.isFadingOut
      ? t("deck_fading")
      : state.isCrossfading
      ? t("deck_crossfading")
      : t("deck_playing");
    playPauseIcon.textContent = "⏸";
    playPauseLabel.textContent = t("play_pause");
  } else {
    onAirBadge.textContent = "OFF AIR";
    onAirBadge.classList.remove("on-air");
    deckDot.className = "deck-status-dot";
    deckStatusText.textContent = hasTrack ? t("deck_paused") : t("deck_ready");
    playPauseIcon.textContent = "▶";
    playPauseLabel.textContent = hasTrack ? t("play_resume") : t("play_start");
  }

  const npNextRow = document.getElementById("npNextRow");
  const npNextText = document.getElementById("npNextText");

  // Mobiles DJ-Dock (unten) synchronisieren
  const mobDot = document.getElementById("mobStatusDot");
  const mobTitle = document.getElementById("mobNowTitle");
  const mobSub = document.getElementById("mobNowSub");
  const mobPlay = document.getElementById("mobPlayPauseBtn");
  const mobFade = document.getElementById("mobFadeOutBtn");
  const mobTalk = document.getElementById("mobTalkoverBtn");

  if (mobPlay) {
    mobPlay.disabled = !hasTrack && state.tracks.length === 0;
    mobPlay.textContent = state.isPlaying ? "⏸" : "▶";
  }
  if (mobFade) mobFade.disabled = !state.isPlaying;
  if (mobTalk) mobTalk.classList.toggle("active", state.isTalkoverActive);
  if (mobDot) {
    mobDot.className = state.isPlaying
      ? "mob-status-dot " + (state.isFadingOut || state.isCrossfading ? "fading" : "playing")
      : "mob-status-dot";
  }

  const curTime = isServerMode() ? state.serverCurrentTime : getActiveAudio().currentTime || 0;

  if (state.currentTrack) {
    npTitle.textContent = state.currentTrack.title;
    npCue.textContent =
      state.currentCue && state.currentCue.id
        ? t("np_active_cue", {
            label: state.currentCue.label,
            time: formatTime(state.currentCue.start_time),
          })
        : t("np_from_start");

    if (mobTitle) mobTitle.textContent = state.currentTrack.title;
    if (mobSub) {
      const modeTag = isServerMode() ? t("mob_mode_server") : t("mob_mode_local");
      mobSub.textContent = state.isPlaying
        ? `${modeTag} • ${formatTime(curTime)} / ${formatTime(state.currentTrack.duration)}`
        : `${modeTag} • ${t("mob_paused")}`;
    }

    if (npNextRow && npNextText) {
      npNextRow.classList.remove("hidden");
      if (state.currentTrack.loop) {
        npNextText.textContent = t("np_next_loop");
      } else if (state.settings.auto_next_enabled) {
        const nextT = getNextTrack(false);
        const modeIcon = state.settings.shuffle_enabled
          ? state.settings.crossfade_enabled
            ? t("np_next_shuffle_xfade")
            : t("np_next_shuffle")
          : state.settings.crossfade_enabled
          ? t("np_next_xfade")
          : t("np_next_after");
        npNextText.textContent = nextT
          ? `${modeIcon}: ${nextT.title}`
          : `${t("np_next_after")}: –`;
      } else {
        npNextText.textContent = t("np_next_stop");
      }
    }

    drawNowPlayingWaveform(curTime, state.currentTrack.duration || 1);
  } else {
    npTitle.textContent = t("np_no_track");
    npCue.textContent = t("np_tap_hint");
    if (npNextRow) npNextRow.classList.add("hidden");
    if (mobTitle) mobTitle.textContent = t("np_no_track");
    if (mobSub) mobSub.textContent = isServerMode() ? t("mob_ready_server") : t("mob_ready_local");
  }
}

// ============================================================================
// WAVEFORM ZEICHNEN (MINI-KARTEN, LIVE-DECK & GROSSER HIGHLIGHT-EDITOR)
// ============================================================================
function drawMiniWaveform(canvas, track) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const isStudio = getTheme() === "studio";
  const peaks = track.peaks && track.peaks.length > 0 ? track.peaks : generateFallbackPeaks(80);
  const barWidth = w / peaks.length;

  ctx.fillStyle = isStudio ? "#262d3a" : "#334155";
  peaks.forEach((p, i) => {
    const barH = Math.max(3, p * (h - 8));
    const x = i * barWidth;
    const y = (h - barH) / 2;
    ctx.fillRect(x, y, Math.max(1.5, barWidth - 1), barH);
  });

  // Highlight-Marker einzeichnen
  const dur = track.duration || 1;
  (track.cues || []).forEach((cue) => {
    const x = Math.min(w - 2, Math.max(1, (cue.start_time / dur) * w));
    ctx.fillStyle = cue.color || (isStudio ? "#38bdf8" : "#f97316");
    ctx.fillRect(x - 1, 0, isStudio ? 2 : 3, h);
  });
}

function drawNowPlayingWaveform(currentTime, duration) {
  const canvas = document.getElementById("npWaveformCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const track = state.currentTrack;
  if (!track) return;

  const isStudio = getTheme() === "studio";
  const peaks = track.peaks && track.peaks.length > 0 ? track.peaks : generateFallbackPeaks(120);
  const dur = duration || track.duration || 1;
  const progressRatio = Math.min(1, Math.max(0, currentTime / dur));
  const barWidth = w / peaks.length;

  peaks.forEach((p, i) => {
    const ratio = i / peaks.length;
    const barH = Math.max(4, p * (h - 12));
    const x = i * barWidth;
    const y = (h - barH) / 2;
    ctx.fillStyle = ratio <= progressRatio ? (isStudio ? "#0ea5e9" : "#f97316") : (isStudio ? "#262d3a" : "#334155");
    ctx.fillRect(x, y, Math.max(2, barWidth - 1.2), barH);
  });

  // Cue-Marker
  (track.cues || []).forEach((cue) => {
    const x = (cue.start_time / dur) * w;
    ctx.fillStyle = cue.color || "#38bdf8";
    ctx.fillRect(x - 1, 0, 2.5, h);
  });

  // Abspielkopf
  const playheadX = progressRatio * w;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(playheadX - 1, 0, 2.5, h);
}

// ============================================================================
// HIGHLIGHT & WAVEFORM EDITOR MODAL
// ============================================================================
function openCueEditor(trackId) {
  const track = state.tracks.find((t) => t.id === trackId);
  if (!track) return;

  state.editingTrackId = trackId;
  state.editorCursorTime =
    track.cues && track.cues.length > 0 ? Number(track.cues[0].start_time) : 0.0;

  document.getElementById("editorTrackTitle").textContent = t("editor_title_prefix", {
    title: track.title,
  });
  document.getElementById("editTrackName").value = track.title;
  document.getElementById("editTrackArtist").value = track.artist || "";
  document.getElementById("editTrackVolume").value = Math.round((track.volume || 1.0) * 100);
  document.getElementById("editTrackLoop").value = track.loop ? "1" : "0";

  const catSelect = document.getElementById("editTrackCategory");
  catSelect.innerHTML = state.categories
    .map(
      (c) =>
        `<option value="${escapeHtml(c.id)}" ${
          c.id === track.category_id ? "selected" : ""
        }>${escapeHtml(c.icon)} ${escapeHtml(getCategoryDisplayName(c))}</option>`
    )
    .join("");

  // Vorschau-Player vorbereiten
  editorAudio.src = track.url;
  editorAudio.currentTime = state.editorCursorTime;

  updateEditorTimeDisplay(track.duration);
  renderEditorCuesList(track);
  drawEditorWaveform(track);

  document.getElementById("cueEditorModal").classList.remove("hidden");
}

function closeCueEditor() {
  editorAudio.pause();
  state.editorIsPlaying = false;
  state.editingTrackId = null;
  document.getElementById("cueEditorModal").classList.add("hidden");
}

function updateEditorTimeDisplay(duration) {
  const cursorSec = state.editorCursorTime;
  document.getElementById("editorCursorTime").textContent = formatTime(cursorSec, true);
  const markBtnTime = document.getElementById("markBtnTime");
  if (markBtnTime) {
    markBtnTime.textContent = formatTime(cursorSec, true);
  }
  if (duration !== undefined) {
    document.getElementById("editorTotalTime").textContent = formatTime(duration, true);
  }
  const playBtn = document.getElementById("editorPlayPauseBtn");
  playBtn.textContent = editorAudio.paused
    ? t("editor_preview_play")
    : t("editor_preview_stop");
}

function drawEditorWaveform(track) {
  const canvas = document.getElementById("editorWaveformCanvas");
  if (!canvas || !track) return;
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const dur = track.duration || editorAudio.duration || 30;
  const peaks = track.peaks && track.peaks.length > 0 ? track.peaks : generateFallbackPeaks(180);
  const barWidth = w / peaks.length;

  // Hintergrund-Hilfslinie
  ctx.strokeStyle = "rgba(255,255,255,0.07)";
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Waveform Balken (kompakt & flach)
  peaks.forEach((p, i) => {
    const barH = Math.max(3, p * (h - 12));
    const x = i * barWidth;
    const y = (h - barH) / 2;
    ctx.fillStyle = "#475569";
    ctx.fillRect(x, y, Math.max(2, barWidth - 1.5), barH);
  });

  // Gespeicherte Highlights (Cue-Points) samt kompakter Fahne zeichnen
  (track.cues || []).forEach((cue, idx) => {
    const startX = Math.max(0, Math.min(w, (cue.start_time / dur) * w));
    const color = cue.color || "#f97316";

    if (cue.end_time && cue.end_time > cue.start_time) {
      const endX = Math.max(0, Math.min(w, (cue.end_time / dur) * w));
      ctx.fillStyle = color + "28";
      ctx.fillRect(startX, 0, endX - startX, h);
    }

    ctx.fillStyle = color;
    ctx.fillRect(startX - 1.5, 0, 2.5, h);

    // Kompakte Nummern-Fahne oben
    ctx.font = "bold 11px sans-serif";
    const text = `#${idx + 1} (${formatTime(cue.start_time)})`;
    const tw = ctx.measureText(text).width + 10;
    const flagX = Math.min(w - tw - 2, Math.max(2, startX + 2));
    ctx.fillStyle = color;
    ctx.fillRect(flagX, 3, tw, 17);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, flagX + 5, 15);
  });

  // Aktueller Cursor (Abspiel-/Markierposition)
  const cursorX = Math.max(0, Math.min(w, (state.editorCursorTime / dur) * w));
  ctx.fillStyle = "#38bdf8";
  ctx.fillRect(cursorX - 1.5, 0, 2.5, h);
  ctx.beginPath();
  ctx.arc(cursorX, h - 7, 4.5, 0, Math.PI * 2);
  ctx.fill();
}

function renderEditorCuesList(track) {
  const container = document.getElementById("editorCuesList");
  const cues = track.cues || [];

  if (cues.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted);">${escapeHtml(
      t("editor_no_cues")
    )}</p>`;
    return;
  }

  container.innerHTML = cues
    .map(
      (cue, idx) => `
      <div class="cue-edit-row" data-cue-id="${cue.id}">
        <input type="color" class="cue-color-picker" value="${escapeHtml(
          cue.color || "#f97316"
        )}" title="${escapeHtml(t("cue_color_title", { num: idx + 1 }))}" />

        <div class="form-group">
          <label>${escapeHtml(t("cue_btn_label_prefix"))} <strong>#${idx + 1}</strong> ${escapeHtml(
        t("cue_btn_label_suffix")
      )}</label>
          <input type="text" class="cue-label-input" value="${escapeHtml(
            cue.label
          )}" placeholder="${escapeHtml(t("cue_label_ph"))}" />
        </div>

        <div class="form-group">
          <label>${escapeHtml(t("cue_start_label"))}</label>
          <div class="cue-time-group">
            <button type="button" class="btn-nudge" data-nudge="-0.5">-0.5s</button>
            <input type="number" class="cue-start-input" step="0.1" min="0" value="${Number(
              cue.start_time
            ).toFixed(1)}" />
            <button type="button" class="btn-nudge" data-nudge="0.5">+0.5s</button>
            <button type="button" class="btn-nudge" data-use-cursor="1" title="${escapeHtml(
              t("cue_use_cursor_title")
            )}">📍</button>
          </div>
        </div>

        <div class="form-group">
          <label>${escapeHtml(t("cue_end_label"))}</label>
          <input type="number" class="cue-end-input" step="0.5" min="0" placeholder="${escapeHtml(
            t("cue_end_ph")
          )}" value="${cue.end_time ? Number(cue.end_time).toFixed(1) : ""}" />
        </div>

        <label class="toggle-row" title="${escapeHtml(t("cue_fade_title"))}">
          <input type="checkbox" class="cue-fade-input" ${cue.fade_in ? "checked" : ""} />
          <span>${escapeHtml(t("cue_fade_label"))}</span>
        </label>

        <div style="display: flex; gap: 6px;">
          <button type="button" class="btn btn-secondary btn-test-cue" title="${escapeHtml(
            t("cue_test_title")
          )}">${escapeHtml(t("cue_test_btn"))}</button>
          <button type="button" class="btn btn-primary btn-save-cue">💾</button>
          <button type="button" class="btn btn-danger btn-del-cue" title="${escapeHtml(
            t("cue_del_title")
          )}">🗑️</button>
        </div>
      </div>
    `
    )
    .join("");

  container.querySelectorAll(".cue-edit-row").forEach((row) => {
    const cueId = Number(row.dataset.cueId);
    const startInput = row.querySelector(".cue-start-input");

    row.querySelectorAll("[data-nudge]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const delta = parseFloat(btn.dataset.nudge);
        const nextVal = Math.max(0, parseFloat(startInput.value || "0") + delta);
        startInput.value = nextVal.toFixed(1);
        saveSingleCueRow(row, cueId);
      });
    });

    const useCursorBtn = row.querySelector("[data-use-cursor]");
    if (useCursorBtn) {
      useCursorBtn.addEventListener("click", () => {
        startInput.value = state.editorCursorTime.toFixed(1);
        saveSingleCueRow(row, cueId);
      });
    }

    row.querySelector(".btn-test-cue").addEventListener("click", () => {
      const startSec = parseFloat(startInput.value || "0");
      state.editorCursorTime = startSec;
      editorAudio.currentTime = startSec;
      editorAudio.play();
      updateEditorTimeDisplay();
    });

    row.querySelector(".btn-save-cue").addEventListener("click", () => {
      saveSingleCueRow(row, cueId);
    });

    // Direktes Auto-Speichern bei Änderung von Farbe, Bezeichnung, Zeiten oder Fade-In
    row
      .querySelectorAll(
        ".cue-color-picker, .cue-label-input, .cue-start-input, .cue-end-input, .cue-fade-input"
      )
      .forEach((inp) => {
        inp.addEventListener("change", () => saveSingleCueRow(row, cueId));
      });

    row.querySelector(".btn-del-cue").addEventListener("click", async () => {
      await fetch(`/api/cues/${cueId}`, { method: "DELETE" });
      await loadStateFromServer();
      const updatedTrack = state.tracks.find((t) => t.id === state.editingTrackId);
      if (updatedTrack) {
        renderEditorCuesList(updatedTrack);
        drawEditorWaveform(updatedTrack);
      }
    });
  });
}

async function saveSingleCueRow(row, cueId) {
  const color = row.querySelector(".cue-color-picker").value;
  const label = row.querySelector(".cue-label-input").value;
  const start_time = parseFloat(row.querySelector(".cue-start-input").value || "0");
  const endRaw = row.querySelector(".cue-end-input").value;
  const end_time = endRaw ? parseFloat(endRaw) : null;
  const fade_in = row.querySelector(".cue-fade-input").checked;

  await fetch(`/api/cues/${cueId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label, start_time, end_time, color, fade_in }),
  });

  await loadStateFromServer();
  const updatedTrack = state.tracks.find((t) => t.id === state.editingTrackId);
  if (updatedTrack) {
    renderEditorCuesList(updatedTrack);
    drawEditorWaveform(updatedTrack);
  }
}

// ============================================================================
// HILFSFUNKTIONEN
// ============================================================================
function formatTime(sec, showTenths = false) {
  if (!sec || isNaN(sec) || sec < 0) return showTenths ? "0:00.0" : "0:00";
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  if (showTenths) {
    const whole = Math.floor(rem);
    const tenths = Math.floor((rem - whole) * 10);
    return `${mins}:${String(whole).padStart(2, "0")}.${tenths}`;
  }
  return `${mins}:${String(Math.floor(rem)).padStart(2, "0")}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function generateFallbackPeaks(len) {
  const arr = [];
  for (let i = 0; i < len; i++) {
    arr.push(0.25 + 0.55 * Math.abs(Math.sin(i * 0.23) * Math.cos(i * 0.07)));
  }
  return arr;
}

// ============================================================================
// INITIALISIERUNG & EVENT LISTENER
// ============================================================================
document.addEventListener("DOMContentLoaded", () => {
  setThemeCode(getTheme());
  applyStaticTranslations();
  loadStateFromServer();
  requestAnimationFrame(updateLiveLoop);
  setInterval(pollServerPlayerStatus, 250);

  // Sicherstellen, dass Klicks auf die Steuerelemente in der Kopfzeile niemals vom Panel-Drag abgefangen werden
  document.querySelectorAll(".panel-header-controls").forEach((ctrlWrap) => {
    ctrlWrap.addEventListener("pointerdown", (e) => e.stopPropagation());
  });

  // Schutz vor versehentlichem Neuladen / Schließen im lokalen Geräte-Modus während laufender Musik!
  window.addEventListener("beforeunload", (e) => {
    if (!isServerMode() && state.isPlaying && !state.manualStopOrFade) {
      saveLocalPlaybackSnapshot();
      e.preventDefault();
      e.returnValue = t("beforeunload_msg");
      return e.returnValue;
    }
  });

  // 1-Tipp-Fortsetzen-Banner (falls auf iPad im lokalen Modus doch ein Reload erzwungen wurde)
  document.getElementById("localResumeBtn").addEventListener("click", () => {
    if (state.pendingResumeSnapshot) {
      const { track, cue, resumeAt } = state.pendingResumeSnapshot;
      state.pendingResumeSnapshot = null;
      triggerTrackCue(track, cue, { resumeAt });
    }
    document.getElementById("localResumeBanner").classList.add("hidden");
  });
  document.getElementById("localResumeDismissBtn").addEventListener("click", () => {
    state.pendingResumeSnapshot = null;
    clearLocalPlaybackSnapshot();
    document.getElementById("localResumeBanner").classList.add("hidden");
  });

  // Ton-Ausgang Umschalter (🔊 Server-Ton vs. 📱 Gerät-Ton)
  document.getElementById("outServerBtn").addEventListener("click", () => setOutputMode("server"));
  document.getElementById("outLocalBtn").addEventListener("click", () => setOutputMode("local"));

  // Kategorie-Dropdown in der Kopfzeile des Lieder-Moduls
  const categorySelect = document.getElementById("categorySelect");
  if (categorySelect) {
    categorySelect.addEventListener("pointerdown", (e) => e.stopPropagation());
    categorySelect.addEventListener("change", (e) => {
      state.activeCategory = e.target.value || "all";
      state.plannedNextTrackId = null;
      categorySelect.classList.toggle("is-filtered", state.activeCategory !== "all");
      renderSoundboard();
      updatePlayerUI();
      if (isServerMode()) {
        sendServerCommand({ action: "set_category", active_category: state.activeCategory });
      }
    });
  }

  // Shuffle-Button in der Kopfzeile der Liederliste (nur Symbol, ohne Textbeschriftung)
  const shuffleQuickBtn = document.getElementById("shuffleQuickBtn");
  if (shuffleQuickBtn) {
    shuffleQuickBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      setShuffleEnabled(!state.settings.shuffle_enabled);
    });
  }

  // Auto-Follow-Button in der Liederliste (nur Symbol, ohne Textbeschriftung)
  const autoFollowBtn = document.getElementById("autoFollowBtn");
  if (autoFollowBtn) {
    autoFollowBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.autoFollowEnabled = !state.autoFollowEnabled;
      autoFollowBtn.classList.toggle("active", state.autoFollowEnabled);
      autoFollowBtn.title = state.autoFollowEnabled
        ? t("autofollow_on_title")
        : t("autofollow_off_title");
      if (state.autoFollowEnabled) {
        scrollActiveTrackIntoView(true);
      }
    });
  }

  // Mobile 3-Tab-Umschaltung (🎵 Liste | 🎚️ Regler | 💿 Aktuell)
  const workspaceEl = document.getElementById("mainWorkspace");
  workspaceEl.dataset.mobActive = "songs";

  function switchMobilePanel(panelName) {
    workspaceEl.dataset.mobActive = panelName;
    document.querySelectorAll("[data-mob-panel]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mobPanel === panelName);
    });
  }

  document.querySelectorAll("[data-mob-panel]").forEach((btn) => {
    btn.addEventListener("click", () => switchMobilePanel(btn.dataset.mobPanel));
  });
  document.getElementById("mobOpenMixerArea").addEventListener("click", () => switchMobilePanel("deck"));

  // Drag & Drop für die 3 Cockpit-Elemente (Liste | Regler | Aktuelles Lied) mit FLIP-Animation
  initPanelDragAndDrop(workspaceEl);

  // Mobile Mini-Player Direkt-Buttons
  document.getElementById("mobPlayPauseBtn").addEventListener("click", togglePlayPause);
  document.getElementById("mobFadeOutBtn").addEventListener("click", () => triggerSmoothFadeOut(false));
  document.getElementById("mobTalkoverBtn").addEventListener("click", toggleTalkover);

  // Ansicht-Umschalter (Kacheln / Liste)
  document.getElementById("viewGridBtn").addEventListener("click", () => setViewMode("grid"));
  document.getElementById("viewListBtn").addEventListener("click", () => setViewMode("list"));

  // Suche
  document.getElementById("searchInput").addEventListener("input", (e) => {
    state.searchQuery = e.target.value;
    renderSoundboard();
  });

  // Transport-Steuerung & Endlosschleife im Live-Deck
  document.getElementById("btnPlayPause").addEventListener("click", togglePlayPause);
  document.getElementById("btnFadeOut").addEventListener("click", () => triggerSmoothFadeOut(false));
  document.getElementById("btnStopImmediate").addEventListener("click", stopImmediate);
  document.getElementById("btnTalkover").addEventListener("click", toggleTalkover);
  document.getElementById("btnSkipNext").addEventListener("click", () => {
    playNextTrack({
      isCrossfade: state.isPlaying && state.settings.crossfade_enabled,
      crossfadeSec: Number(state.settings.fade_out_duration || 2.0),
    });
  });
  document.getElementById("btnNowPlayingLoop").addEventListener("click", () => {
    if (state.currentTrack) {
      toggleTrackLoop(state.currentTrack.id);
    }
  });

  // Live-Waveform Klick zum Springen im laufenden Lied
  document.getElementById("npWaveformWrap").addEventListener("click", (e) => {
    if (!state.currentTrack) return;
    const canvas = document.getElementById("npWaveformCanvas");
    const rect = canvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (isServerMode()) {
      const dur = state.currentTrack.duration || 0;
      if (dur > 0) {
        sendServerCommand({ action: "seek", time: ratio * dur });
      }
      return;
    }
    const activeAudio = getActiveAudio();
    const dur = activeAudio.duration || state.currentTrack.duration || 0;
    if (dur > 0) {
      activeAudio.currentTime = ratio * dur;
      drawNowPlayingWaveform(activeAudio.currentTime, dur);
    }
  });

  // Virtueller senkrechter Master-Schieberegler (Mischpult-Fader für iPad & Maus)
  const vFaderTrack = document.getElementById("verticalFaderTrack");
  const vFaderSlot = document.getElementById("verticalFaderSlot");
  let lastLiveVolSent = 0;

  function pushVolumeUpdate(persist = false) {
    if (isServerMode()) {
      const now = performance.now();
      if (persist || now - lastLiveVolSent > 50) {
        lastLiveVolSent = now;
        sendServerCommand({
          action: "volume",
          master_volume: state.settings.master_volume,
          persist,
        });
      }
    } else if (persist) {
      fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ master_volume: state.settings.master_volume.toFixed(2) }),
      });
    }
  }

  function setMasterPctFromClientY(clientY, persist = false) {
    if (!isServerMode()) ensureAudioContext();
    const rect = vFaderSlot.getBoundingClientRect();
    if (rect.height <= 0) return;
    const rawRatio = 1 - (clientY - rect.top) / rect.height;
    const pct = Math.max(0, Math.min(100, Math.round(rawRatio * 100)));
    state.settings.master_volume = pct / 100;
    updateVerticalFaderUI(pct);
    if (!isServerMode()) {
      applyEffectiveVolume();
    }
    pushVolumeUpdate(persist);
  }

  vFaderTrack.addEventListener("pointerdown", (e) => {
    state.isDraggingFader = true;
    try {
      vFaderTrack.setPointerCapture(e.pointerId);
    } catch (_) {}
    setMasterPctFromClientY(e.clientY, false);
  });

  vFaderTrack.addEventListener("pointermove", (e) => {
    if (!state.isDraggingFader) return;
    setMasterPctFromClientY(e.clientY, false);
  });

  function finishFaderDrag(e) {
    if (!state.isDraggingFader) return;
    state.isDraggingFader = false;
    try {
      vFaderTrack.releasePointerCapture(e.pointerId);
    } catch (_) {}
    pushVolumeUpdate(true);
  }

  vFaderTrack.addEventListener("pointerup", finishFaderDrag);
  vFaderTrack.addEventListener("pointercancel", finishFaderDrag);

  // Mausrad & Pfeiltasten-Unterstützung am PC
  vFaderTrack.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      if (!isServerMode()) ensureAudioContext();
      const delta = e.deltaY < 0 ? 3 : -3;
      const nextPct = Math.max(0, Math.min(100, Math.round(state.settings.master_volume * 100) + delta));
      state.settings.master_volume = nextPct / 100;
      updateVerticalFaderUI(nextPct);
      if (!isServerMode()) applyEffectiveVolume();
      pushVolumeUpdate(true);
    },
    { passive: false }
  );

  vFaderTrack.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    if (!isServerMode()) ensureAudioContext();
    const delta = e.key === "ArrowUp" ? 5 : -5;
    const nextPct = Math.max(0, Math.min(100, Math.round(state.settings.master_volume * 100) + delta));
    state.settings.master_volume = nextPct / 100;
    updateVerticalFaderUI(nextPct);
    if (!isServerMode()) applyEffectiveVolume();
    pushVolumeUpdate(true);
  });

  // Senkrechte Schnellwahl-Buttons für Lautstärke (100%, 85%, 65%, 40%, 20%, 0%)
  document.querySelectorAll(".quick-vol-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (!isServerMode()) ensureAudioContext();
      const targetPct = Number(btn.dataset.vol);
      state.settings.master_volume = targetPct / 100;
      updateVerticalFaderUI(targetPct);
      if (!isServerMode()) applyEffectiveVolume();
      pushVolumeUpdate(true);
    });
  });

  // Auto-Fade & Auto-Next Toggles
  document.getElementById("autoFadeToggle").addEventListener("change", (e) => {
    state.settings.auto_fade_enabled = e.target.checked;
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_fade_enabled: String(e.target.checked) }),
    });
  });

  document.getElementById("autoNextToggle").addEventListener("change", (e) => {
    state.settings.auto_next_enabled = e.target.checked;
    updatePlayerUI();
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_next_enabled: String(e.target.checked) }),
    });
  });

  const shuffleToggleEl = document.getElementById("shuffleToggle");
  if (shuffleToggleEl) {
    shuffleToggleEl.addEventListener("change", (e) => {
      setShuffleEnabled(e.target.checked);
    });
  }

  document.getElementById("crossfadeToggle").addEventListener("change", (e) => {
    state.settings.crossfade_enabled = e.target.checked;
    updatePlayerUI();
    fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ crossfade_enabled: String(e.target.checked) }),
    });
  });

  // ==========================================================================
  // EDITOR MODAL EVENTS
  // ==========================================================================
  async function saveEditorTrackMetadata() {
    if (!state.editingTrackId) return;
    const title = document.getElementById("editTrackName").value.trim() || t("unnamed_track");
    const artist = document.getElementById("editTrackArtist").value.trim();
    const category_id = document.getElementById("editTrackCategory").value;
    const volume = Math.max(
      0.1,
      Math.min(1.5, Number(document.getElementById("editTrackVolume").value) / 100)
    );
    const loop = document.getElementById("editTrackLoop").value === "1";

    await fetch(`/api/tracks/${state.editingTrackId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, artist, category_id, volume, loop }),
    });

    await loadStateFromServer();
  }

  async function saveAndCloseCueEditor() {
    if (state.editingTrackId) {
      await saveEditorTrackMetadata();
    }
    closeCueEditor();
  }

  document.getElementById("closeCueEditorBtn").addEventListener("click", saveAndCloseCueEditor);
  document.getElementById("doneCueEditorBtn").addEventListener("click", saveAndCloseCueEditor);

  // Direktes Auto-Speichern, sobald Kategorie, Loop, Lautstärke oder Titel geändert wird!
  [
    "editTrackCategory",
    "editTrackLoop",
    "editTrackVolume",
    "editTrackName",
    "editTrackArtist",
  ].forEach((fieldId) => {
    const el = document.getElementById(fieldId);
    if (el) {
      el.addEventListener("change", saveEditorTrackMetadata);
    }
  });

  const editorCanvas = document.getElementById("editorWaveformCanvas");
  let isDraggingWaveform = false;

  function scrubEditorWaveform(clientX) {
    const track = state.tracks.find((t) => t.id === state.editingTrackId);
    if (!track) return;
    const rect = editorCanvas.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const dur = track.duration || editorAudio.duration || 30;
    state.editorCursorTime = roundToTenth(ratio * dur);
    editorAudio.currentTime = state.editorCursorTime;
    updateEditorTimeDisplay(dur);
    drawEditorWaveform(track);
  }

  editorCanvas.addEventListener("pointerdown", (e) => {
    isDraggingWaveform = true;
    scrubEditorWaveform(e.clientX);
  });
  window.addEventListener("pointermove", (e) => {
    if (isDraggingWaveform) scrubEditorWaveform(e.clientX);
  });
  window.addEventListener("pointerup", () => {
    isDraggingWaveform = false;
  });

  editorAudio.addEventListener("timeupdate", () => {
    if (!state.editingTrackId) return;
    state.editorCursorTime = editorAudio.currentTime;
    const track = state.tracks.find((t) => t.id === state.editingTrackId);
    updateEditorTimeDisplay(track ? track.duration : editorAudio.duration);
    if (track) drawEditorWaveform(track);
  });

  editorAudio.addEventListener("play", () => updateEditorTimeDisplay());
  editorAudio.addEventListener("pause", () => updateEditorTimeDisplay());

  document.getElementById("editorPlayPauseBtn").addEventListener("click", () => {
    if (!isServerMode()) {
      stopImmediate();
    }
    if (editorAudio.paused) {
      editorAudio.currentTime = state.editorCursorTime;
      editorAudio.play();
    } else {
      editorAudio.pause();
    }
  });

  document.getElementById("editorStepBackBtn").addEventListener("click", () => {
    state.editorCursorTime = Math.max(0, state.editorCursorTime - 2.0);
    editorAudio.currentTime = state.editorCursorTime;
    const track = state.tracks.find((t) => t.id === state.editingTrackId);
    updateEditorTimeDisplay();
    if (track) drawEditorWaveform(track);
  });

  document.getElementById("editorStepFwdBtn").addEventListener("click", () => {
    const track = state.tracks.find((t) => t.id === state.editingTrackId);
    const maxDur = track ? track.duration : editorAudio.duration || 300;
    state.editorCursorTime = Math.min(maxDur, state.editorCursorTime + 2.0);
    editorAudio.currentTime = state.editorCursorTime;
    updateEditorTimeDisplay();
    if (track) drawEditorWaveform(track);
  });

  // Neues Highlight an aktueller Cursor-Position anlegen
  document.getElementById("markCurrentPosBtn").addEventListener("click", async () => {
    if (!state.editingTrackId) return;
    const track = state.tracks.find((t) => t.id === state.editingTrackId);
    const cueCount = track && track.cues ? track.cues.length : 0;
    const colors = ["#f97316", "#38bdf8", "#22c55e", "#a855f7", "#eab308", "#ec4899"];
    const nextColor = colors[cueCount % colors.length];
    const startSec = roundToTenth(state.editorCursorTime);

    await fetch(`/api/tracks/${state.editingTrackId}/cues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        label: String(cueCount + 1),
        start_time: startSec,
        end_time: null,
        color: nextColor,
        fade_in: true,
      }),
    });

    await loadStateFromServer();
    const updatedTrack = state.tracks.find((t) => t.id === state.editingTrackId);
    if (updatedTrack) {
      renderEditorCuesList(updatedTrack);
      drawEditorWaveform(updatedTrack);
    }
  });

  // Lied-Stammdaten speichern
  document.getElementById("saveTrackMetaBtn").addEventListener("click", saveEditorTrackMetadata);

  // Lied löschen
  document.getElementById("deleteTrackBtn").addEventListener("click", async () => {
    if (!state.editingTrackId) return;
    const track = state.tracks.find((t) => t.id === state.editingTrackId);
    if (
      !confirm(
        t("confirm_delete_track", {
          title: track ? track.title : t("unnamed_track"),
        })
      )
    ) {
      return;
    }
    await fetch(`/api/tracks/${state.editingTrackId}`, { method: "DELETE" });
    closeCueEditor();
    await loadStateFromServer();
  });

  // ==========================================================================
  // UPLOAD MODAL & DIREKTES MP3 DRAG-AND-DROP IM LIEDER-MODUL
  // ==========================================================================
  const uploadModal = document.getElementById("uploadModal");
  const uploadFileInput = document.getElementById("uploadFileInput");
  const panelSongsEl = document.getElementById("panelSongs");
  const songsDropOverlay = document.getElementById("songsDropOverlay");
  const songsDropCatLabel = document.getElementById("songsDropCatLabel");
  const songsInlineUpload = document.getElementById("songsInlineUpload");
  let inlineUploadTimer = null;

  function resolveDropCategory() {
    if (state.activeCategory && state.activeCategory !== "all") {
      const activeCat = state.categories.find((c) => c.id === state.activeCategory);
      if (activeCat) return { cat: activeCat, isAllFallback: false };
    }
    const fallback = state.categories[0] || {
      id: "action",
      name: "Zwischen Athleten",
      icon: "🔥",
    };
    return { cat: fallback, isAllFallback: true };
  }

  function hasFileTransfer(e) {
    if (!e.dataTransfer || !e.dataTransfer.types) return false;
    return Array.from(e.dataTransfer.types).includes("Files");
  }

  function showInlineUploadBanner(msg, mode = "loading", autoHideMs = 0) {
    if (!songsInlineUpload) return;
    if (inlineUploadTimer) {
      clearTimeout(inlineUploadTimer);
      inlineUploadTimer = null;
    }
    songsInlineUpload.textContent = msg;
    songsInlineUpload.classList.remove("hidden", "is-done", "is-error");
    if (mode === "done") songsInlineUpload.classList.add("is-done");
    if (mode === "error") songsInlineUpload.classList.add("is-error");
    if (autoHideMs > 0) {
      inlineUploadTimer = setTimeout(() => {
        songsInlineUpload.classList.add("hidden");
      }, autoHideMs);
    }
  }

  // Verhindert, dass ein versehentlich neben das Panel gezogenes MP3 die Seite verlässt!
  window.addEventListener("dragover", (e) => {
    if (hasFileTransfer(e)) {
      e.preventDefault();
    }
  });
  window.addEventListener("drop", (e) => {
    if (hasFileTransfer(e)) {
      e.preventDefault();
      if (songsDropOverlay) songsDropOverlay.classList.add("hidden");
    }
  });

  if (panelSongsEl && songsDropOverlay) {
    panelSongsEl.addEventListener("dragenter", (e) => {
      if (!hasFileTransfer(e)) return;
      e.preventDefault();
      const { cat, isAllFallback } = resolveDropCategory();
      const catLabel = getCategoryDisplayName(cat);
      if (songsDropCatLabel) {
        songsDropCatLabel.textContent = isAllFallback
          ? t("drop_sub_fallback", { icon: cat.icon, name: catLabel })
          : t("drop_sub_assigned", { icon: cat.icon, name: catLabel });
      }
      songsDropOverlay.classList.remove("hidden");
    });

    panelSongsEl.addEventListener("dragover", (e) => {
      if (!hasFileTransfer(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      if (songsDropOverlay.classList.contains("hidden")) {
        songsDropOverlay.classList.remove("hidden");
      }
    });

    panelSongsEl.addEventListener("dragleave", (e) => {
      if (!e.relatedTarget || !panelSongsEl.contains(e.relatedTarget)) {
        songsDropOverlay.classList.add("hidden");
      }
    });

    panelSongsEl.addEventListener("drop", async (e) => {
      if (!hasFileTransfer(e)) return;
      e.preventDefault();
      e.stopPropagation();
      songsDropOverlay.classList.add("hidden");

      const audioExtRe = /\.(mp3|wav|m4a|ogg|flac|aac|opus|webm|mp4)$/i;
      const droppedFiles = Array.from(e.dataTransfer.files || []).filter(
        (f) => (f.type && f.type.startsWith("audio/")) || audioExtRe.test(f.name)
      );

      if (droppedFiles.length === 0) {
        showInlineUploadBanner(t("drop_err_no_audio"), "error", 3500);
        return;
      }

      const { cat } = resolveDropCategory();
      const catLabel = getCategoryDisplayName(cat);
      const formData = new FormData();
      droppedFiles.forEach((file) => formData.append("files", file));
      formData.append("category_id", cat.id);
      formData.append("color", "#f97316");

      showInlineUploadBanner(
        droppedFiles.length === 1
          ? t("drop_uploading_one", { icon: cat.icon, name: catLabel })
          : t("drop_uploading_many", {
              count: droppedFiles.length,
              icon: cat.icon,
              name: catLabel,
            }),
        "loading"
      );

      try {
        const res = await fetch("/api/tracks", {
          method: "POST",
          body: formData,
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        await loadStateFromServer();
        showInlineUploadBanner(
          droppedFiles.length === 1
            ? t("drop_done_one", { icon: cat.icon, name: catLabel })
            : t("drop_done_many", {
                count: droppedFiles.length,
                icon: cat.icon,
                name: catLabel,
              }),
          "done",
          3200
        );
      } catch (err) {
        showInlineUploadBanner(
          t("drop_err_upload", { err: err.message }),
          "error",
          4500
        );
      }
    });
  }

  function populateUploadAndSpotdlCategories() {
    const isStudio = typeof getTheme === "function" && getTheme() === "studio";
    const sel = document.getElementById("uploadCategorySelect");
    if (sel) {
      sel.innerHTML = state.categories
        .map((c) => {
          const prefix = isStudio ? "" : `${escapeHtml(c.icon)} `;
          return `<option value="${escapeHtml(c.id)}" ${
            c.id === state.activeCategory ? "selected" : ""
          }>${prefix}${escapeHtml(getCategoryDisplayName(c))}</option>`;
        })
        .join("");
    }

    const spotSel = document.getElementById("spotdlCategorySelect");
    if (spotSel) {
      const prevVal = spotSel.value;
      const autoOpt = `<option value="__playlist__">${escapeHtml(t("spotdl_auto_cat_opt"))}</option>`;
      const catOpts = state.categories
        .map((c) => {
          const prefix = isStudio ? "" : `${escapeHtml(c.icon)} `;
          return `<option value="${escapeHtml(c.id)}">${prefix}${escapeHtml(getCategoryDisplayName(c))}</option>`;
        })
        .join("");
      spotSel.innerHTML = autoOpt + catOpts;
      if (prevVal && Array.from(spotSel.options).some((o) => o.value === prevVal)) {
        spotSel.value = prevVal;
      } else {
        spotSel.value = "__playlist__";
      }
    }
  }

  function setUploadModalTab(tab) {
    const isSpotdl = tab === "spotdl";
    const tabFilesBtn = document.getElementById("uploadTabFilesBtn");
    const tabSpotdlBtn = document.getElementById("uploadTabSpotdlBtn");
    const uploadFormEl = document.getElementById("uploadForm");
    const spotdlPaneEl = document.getElementById("spotdlTabPane");

    if (tabFilesBtn) tabFilesBtn.classList.toggle("active", !isSpotdl);
    if (tabSpotdlBtn) tabSpotdlBtn.classList.toggle("active", isSpotdl);
    if (uploadFormEl) uploadFormEl.classList.toggle("hidden", isSpotdl);
    if (spotdlPaneEl) spotdlPaneEl.classList.toggle("hidden", !isSpotdl);
  }

  document.getElementById("uploadTabFilesBtn")?.addEventListener("click", () => {
    setUploadModalTab("files");
  });
  document.getElementById("uploadTabSpotdlBtn")?.addEventListener("click", () => {
    setUploadModalTab("spotdl");
  });

  document.getElementById("openUploadBtn").addEventListener("click", () => {
    populateUploadAndSpotdlCategories();
    uploadFileInput.value = "";
    document.getElementById("selectedFilesLabel").textContent = t("dropzone_sub_default");
    document.getElementById("uploadProgressBox").classList.add("hidden");
    setUploadModalTab("files");
    uploadModal.classList.remove("hidden");
  });

  document.getElementById("openSpotifyBtn")?.addEventListener("click", () => {
    populateUploadAndSpotdlCategories();
    setUploadModalTab("spotdl");
    uploadModal.classList.remove("hidden");
    setTimeout(() => {
      document.getElementById("spotdlQueryInput")?.focus();
    }, 60);
  });

  document.getElementById("closeUploadBtn").addEventListener("click", () => {
    uploadModal.classList.add("hidden");
  });
  document.getElementById("cancelUploadBtn").addEventListener("click", () => {
    uploadModal.classList.add("hidden");
  });
  document.getElementById("closeSpotdlTabBtn")?.addEventListener("click", () => {
    uploadModal.classList.add("hidden");
  });

  // ==========================================================================
  // SPOTIFY / SPOTDL DOWNLOAD LOGIK & LIVE-POLLING
  // ==========================================================================
  let spotdlPollTimer = null;
  let lastSpotdlImportedCount = 0;

  function renderSpotdlStatus(job) {
    if (!job) return;
    const progBox = document.getElementById("spotdlProgressBox");
    const statusText = document.getElementById("spotdlStatusText");
    const countBadge = document.getElementById("spotdlCountBadge");
    const barFill = document.getElementById("spotdlProgressBar");
    const importedList = document.getElementById("spotdlImportedList");
    const logOutput = document.getElementById("spotdlLogOutput");
    const startBtn = document.getElementById("startSpotdlBtn");
    const stopBtn = document.getElementById("stopSpotdlBtn");
    const headerBtn = document.getElementById("openSpotifyBtn");

    if (headerBtn) {
      headerBtn.classList.toggle("running", Boolean(job.running));
    }

    if (job.status === "idle" && !job.running && (!job.log_lines || job.log_lines.length === 0)) {
      if (progBox) progBox.classList.add("hidden");
      if (startBtn) {
        startBtn.disabled = false;
        startBtn.textContent = t("spotdl_start_btn");
      }
      if (stopBtn) stopBtn.classList.add("hidden");
      return;
    }

    if (progBox) progBox.classList.remove("hidden");
    if (statusText) statusText.textContent = job.message || "";

    const done = Number(job.completed_count || 0);
    const total = Number(job.total_count || 0);
    if (countBadge) {
      countBadge.textContent = total > 0 ? `${done} / ${total}` : `${done} MP3`;
    }

    if (barFill) {
      let pct = 0;
      if (total > 0) {
        pct = Math.min(100, Math.round((done / total) * 100));
        if (job.running && pct < 8) pct = 8;
      } else if (job.running) {
        pct = 30;
      } else if (job.status === "done") {
        pct = 100;
      }
      barFill.style.width = `${pct}%`;
    }

    if (importedList) {
      const tracks = job.imported_tracks || [];
      importedList.innerHTML = tracks
        .map(
          (tr) =>
            `<span class="spotdl-imported-pill">✓ ${escapeHtml(
              tr.artist ? `${tr.artist} – ${tr.title}` : tr.title
            )}</span>`
        )
        .join("");
    }

    if (logOutput) {
      const lines = job.log_lines || [];
      logOutput.textContent = lines.join("\n");
      logOutput.scrollTop = logOutput.scrollHeight;
    }

    if (startBtn) {
      startBtn.disabled = Boolean(job.running);
      startBtn.textContent = job.running ? t("spotdl_running_btn") : t("spotdl_start_btn");
    }
    if (stopBtn) {
      stopBtn.classList.toggle("hidden", !job.running);
    }
  }

  async function pollSpotdlStatus() {
    try {
      const res = await fetch("/api/spotdl/status");
      if (!res.ok) return;
      const job = await res.json();
      renderSpotdlStatus(job);

      const done = Number(job.completed_count || 0);
      if (done > lastSpotdlImportedCount) {
        lastSpotdlImportedCount = done;
        await loadStateFromServer();
        populateUploadAndSpotdlCategories();
      }

      if (!job.running) {
        if (spotdlPollTimer) {
          clearInterval(spotdlPollTimer);
          spotdlPollTimer = null;
        }
        if (done > 0) {
          await loadStateFromServer();
          if (job.created_category_id) {
            state.activeCategory = job.created_category_id;
            renderCategories();
            renderSoundboard();
          }
          populateUploadAndSpotdlCategories();
        }
      }
    } catch (_) {
      // Netzwerkfehler beim Polling ignorieren
    }
  }

  function startSpotdlPolling() {
    if (spotdlPollTimer) clearInterval(spotdlPollTimer);
    spotdlPollTimer = setInterval(pollSpotdlStatus, 1200);
    pollSpotdlStatus();
  }

  document.getElementById("startSpotdlBtn")?.addEventListener("click", async () => {
    const queryEl = document.getElementById("spotdlQueryInput");
    const catEl = document.getElementById("spotdlCategorySelect");
    const colorEl = document.getElementById("spotdlColorInput");
    const rawQuery = (queryEl?.value || "").trim();
    if (!rawQuery) {
      alert(t("spotdl_err_empty"));
      queryEl?.focus();
      return;
    }

    lastSpotdlImportedCount = 0;
    const startBtn = document.getElementById("startSpotdlBtn");
    if (startBtn) startBtn.disabled = true;

    try {
      const res = await fetch("/api/spotdl/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: rawQuery,
          category_id: catEl?.value || "__playlist__",
          fallback_category_id:
            state.activeCategory && state.activeCategory !== "all"
              ? state.activeCategory
              : "action",
          color: colorEl?.value || "#22c55e",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        alert(data.error || "Fehler beim Starten des Spotify-Downloads.");
        if (startBtn) startBtn.disabled = false;
        return;
      }
      renderSpotdlStatus(data.job);
      startSpotdlPolling();
    } catch (err) {
      alert(t("err_upload_alert", { err: err.message }));
      if (startBtn) startBtn.disabled = false;
    }
  });

  document.getElementById("stopSpotdlBtn")?.addEventListener("click", async () => {
    try {
      const res = await fetch("/api/spotdl/cancel", { method: "POST" });
      const data = await res.json();
      if (data.job) renderSpotdlStatus(data.job);
    } catch (_) {}
  });

  // Beim Laden prüfen, ob im Hintergrund noch ein spotDL-Job aktiv ist
  fetch("/api/spotdl/status")
    .then((r) => (r.ok ? r.json() : null))
    .then((job) => {
      if (job && job.running) {
        lastSpotdlImportedCount = Number(job.completed_count || 0);
        renderSpotdlStatus(job);
        startSpotdlPolling();
      }
    })
    .catch(() => {});

  uploadFileInput.addEventListener("change", () => {
    const count = uploadFileInput.files ? uploadFileInput.files.length : 0;
    if (count > 0) {
      const names = Array.from(uploadFileInput.files)
        .map((f) => f.name)
        .join(", ");
      document.getElementById("selectedFilesLabel").textContent = t(
        "dropzone_files_selected",
        { count, names }
      );
    }
  });

  document.getElementById("uploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!uploadFileInput.files || uploadFileInput.files.length === 0) return;

    const formData = new FormData(e.target);
    document.getElementById("uploadProgressBox").classList.remove("hidden");
    document.getElementById("submitUploadBtn").disabled = true;

    try {
      const res = await fetch("/api/tracks", {
        method: "POST",
        body: formData,
      });
      const result = await res.json();
      await loadStateFromServer();
      uploadModal.classList.add("hidden");

      // Falls genau 1 Lied hochgeladen wurde, direkt den Highlight-Editor öffnen!
      if (result.created_ids && result.created_ids.length === 1) {
        openCueEditor(result.created_ids[0]);
      }
    } catch (err) {
      alert(t("err_upload_alert", { err: err.message }));
    } finally {
      document.getElementById("submitUploadBtn").disabled = false;
      document.getElementById("uploadProgressBox").classList.add("hidden");
    }
  });

  // ==========================================================================
  // SETTINGS, SPRACHE & WLAN MODAL EVENTS
  // ==========================================================================
  const settingsModal = document.getElementById("settingsModal");

  function renderSettingsCategories() {
    const list = document.getElementById("settingsCategoriesList");
    list.innerHTML = state.categories
      .map(
        (c) => `
        <span class="settings-cat-pill">
          <span>${escapeHtml(c.icon)} ${escapeHtml(getCategoryDisplayName(c))}</span>
          ${
            c.id !== "action"
              ? `<button type="button" data-del-cat="${escapeHtml(c.id)}" title="${escapeHtml(
                  t("del_cat_title")
                )}">✕</button>`
              : ""
          }
        </span>
      `
      )
      .join("");

    list.querySelectorAll("[data-del-cat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        await fetch(`/api/categories/${btn.dataset.delCat}`, { method: "DELETE" });
        await loadStateFromServer();
        renderSettingsCategories();
      });
    });
  }

  function renderSecuritySection() {
    const magicInput = document.getElementById("magicLanUrlInput");
    const shortLanEl = document.getElementById("lanUrlDisplay");
    const badge = document.getElementById("securityStatusBadge");
    const pinBadge = document.getElementById("pinHintBadge");
    const authEnabledCb = document.getElementById("setAuthEnabled");
    const authLocalhostCb = document.getElementById("setAuthLocalhost");

    shortLanEl.textContent = state.serverInfo.lan_url || window.location.origin;
    magicInput.value = state.serverInfo.magic_lan_url || window.location.origin;
    const qrImg = document.getElementById("magicQrImg");
    if (qrImg) {
      qrImg.src = `/api/auth/qr.svg?t=${Date.now()}`;
    }

    const isProtected = Boolean(state.authInfo.auth_enabled);
    authEnabledCb.checked = isProtected;
    authLocalhostCb.checked = Boolean(state.authInfo.auth_require_on_localhost);

    if (isProtected) {
      badge.textContent = t("sec_protected");
      badge.classList.remove("off");
    } else {
      badge.textContent = t("sec_open");
      badge.classList.add("off");
    }

    if (state.authInfo.initial_pin_hint) {
      pinBadge.textContent = t("pin_initial", { pin: state.authInfo.initial_pin_hint });
    } else {
      pinBadge.textContent = t("pin_custom");
    }
  }

  function showSecFeedback(msg, isError = false) {
    const el = document.getElementById("secFeedbackMsg");
    el.textContent = msg;
    el.style.color = isError ? "#fca5a5" : "#86efac";
  }

  function renderUpdateVersionInfo() {
    const badge = document.getElementById("currentVersionBadge");
    const details = document.getElementById("currentVersionDetails");
    if (!badge || !details) return;

    if (state.systemVersion && state.systemVersion.git_available && state.systemVersion.local_short) {
      badge.textContent = t("version_commit_badge", {
        short: state.systemVersion.local_short,
      });
      details.textContent = t("version_details_git", {
        short: state.systemVersion.local_short,
        date: state.systemVersion.local_date || "local",
        subject: state.systemVersion.local_subject || "",
      });
    } else {
      badge.textContent = t("version_local_badge");
      details.textContent = t("version_details_fallback");
    }
  }

  // Sofortiger Design-Wechsel (Studio Pro vs. Arena Klassik)
  document.querySelectorAll("[data-theme-select]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextTheme = setThemeCode(btn.dataset.themeSelect);
      state.settings.design_theme = nextTheme;

      applyStaticTranslations();
      syncControlsWithSettings();
      renderCategories();
      renderSoundboard();
      updatePlayerUI();
      renderSecuritySection();
      renderSettingsCategories();
      renderUpdateVersionInfo();

      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ design_theme: nextTheme }),
      });
    });
  });

  // Sofortiger Sprachwechsel (DE / EN / FR)
  document.querySelectorAll("[data-lang-select]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const nextLang = setLangCode(btn.dataset.langSelect);
      state.settings.language = nextLang;

      applyStaticTranslations();
      syncControlsWithSettings();
      renderCategories();
      renderSoundboard();
      updatePlayerUI();
      renderSecuritySection();
      renderSettingsCategories();
      renderUpdateVersionInfo();
      setUpdateStatus("");

      await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ language: nextLang }),
      });
    });
  });

  const checkUpdateBtn = document.getElementById("checkUpdateBtn");
  const installUpdateBtn = document.getElementById("installUpdateBtn");
  const updateStatusBox = document.getElementById("updateStatusBox");
  const updateStatusText = document.getElementById("updateStatusText");
  const updateChangelogList = document.getElementById("updateChangelogList");

  function setUpdateStatus(message, { isError = false, hasUpdate = false, changelog = [] } = {}) {
    if (!updateStatusBox || !updateStatusText || !updateChangelogList) return;
    if (!message) {
      updateStatusBox.classList.add("hidden");
      return;
    }
    updateStatusBox.classList.remove("hidden", "has-update", "is-error");
    if (hasUpdate) updateStatusBox.classList.add("has-update");
    if (isError) updateStatusBox.classList.add("is-error");
    updateStatusText.textContent = message;

    if (changelog && changelog.length > 0) {
      updateChangelogList.innerHTML = changelog
        .map((entry) => `<li>${escapeHtml(entry)}</li>`)
        .join("");
      updateChangelogList.classList.remove("hidden");
    } else {
      updateChangelogList.innerHTML = "";
      updateChangelogList.classList.add("hidden");
    }
  }

  async function waitForServerAndReload() {
    for (let attempt = 0; attempt < 25; attempt++) {
      await new Promise((r) => setTimeout(r, 650));
      try {
        const probe = await fetch(`/api/state?t=${Date.now()}`, { cache: "no-store" });
        if (probe.ok || probe.status === 401) {
          state.manualStopOrFade = true;
          window.location.reload();
          return;
        }
      } catch (_) {
        // Server startet noch neu – kurz weiter warten
      }
    }
    state.manualStopOrFade = true;
    window.location.reload();
  }

  if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener("click", async () => {
      checkUpdateBtn.disabled = true;
      checkUpdateBtn.textContent = t("checking_update_btn");
      installUpdateBtn.classList.add("hidden");
      setUpdateStatus(t("update_checking_msg"));

      try {
        const res = await fetch("/api/system/update-check", { cache: "no-store" });
        const info = await res.json();

        if (info.local_short) {
          state.systemVersion = info;
          renderUpdateVersionInfo();
        }

        if (!res.ok || !info.ok) {
          setUpdateStatus(`⚠️ ${info.error || t("update_check_failed")}`, {
            isError: true,
          });
          return;
        }

        if (info.update_available) {
          const count = info.commits_behind || 1;
          setUpdateStatus(
            count === 1
              ? t("update_available_one", { short: info.remote_short })
              : t("update_available_many", { count, short: info.remote_short }),
            { hasUpdate: true, changelog: info.changelog || [] }
          );
          installUpdateBtn.classList.remove("hidden");
        } else {
          setUpdateStatus(t("update_up_to_date_msg", { short: info.local_short }));
        }
      } catch (err) {
        setUpdateStatus(t("update_conn_err", { err: err.message }), {
          isError: true,
        });
      } finally {
        checkUpdateBtn.disabled = false;
        checkUpdateBtn.textContent = t("check_update_btn");
      }
    });
  }

  if (installUpdateBtn) {
    installUpdateBtn.addEventListener("click", async () => {
      if (state.isPlaying && !confirm(t("confirm_update_playing"))) {
        return;
      }

      installUpdateBtn.disabled = true;
      checkUpdateBtn.disabled = true;
      installUpdateBtn.textContent = t("installing_update_btn");
      setUpdateStatus(t("update_downloading_msg"));

      try {
        const res = await fetch("/api/system/update", { method: "POST" });
        const result = await res.json();

        if (!res.ok || !result.ok) {
          setUpdateStatus(`⚠️ ${result.error || t("update_install_failed")}`, {
            isError: true,
          });
          installUpdateBtn.disabled = false;
          checkUpdateBtn.disabled = false;
          installUpdateBtn.textContent = t("install_update_btn");
          return;
        }

        installUpdateBtn.classList.add("hidden");
        if (result.restarting) {
          setUpdateStatus(
            t("update_restarting_msg", { short: result.local_short || "OK" }),
            { hasUpdate: true }
          );
          await waitForServerAndReload();
        } else {
          setUpdateStatus(
            t("update_done_reload_msg", { short: result.local_short || "OK" }),
            { hasUpdate: true }
          );
          setTimeout(() => {
            state.manualStopOrFade = true;
            window.location.reload();
          }, 700);
        }
      } catch (_) {
        setUpdateStatus(t("update_fast_restart_msg"), { hasUpdate: true });
        await waitForServerAndReload();
      }
    });
  }

  document.getElementById("openSettingsBtn").addEventListener("click", () => {
    document.getElementById("setFadeIn").value = state.settings.fade_in_duration;
    document.getElementById("setFadeOut").value = state.settings.fade_out_duration;
    document.getElementById("setCrossfadeDur").value = state.settings.crossfade_duration;
    document.getElementById("setDuckingVol").value = Math.round(state.settings.ducking_volume * 100);
    document.getElementById("setDuckingFade").value = state.settings.ducking_fade;
    document.getElementById("newPasswordInput").value = "";
    document.querySelectorAll("[data-lang-select]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.langSelect === getLang());
    });
    document.querySelectorAll("[data-theme-select]").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.themeSelect === getTheme());
    });
    showSecFeedback("");
    renderSecuritySection();
    renderSettingsCategories();
    renderUpdateVersionInfo();
    settingsModal.classList.remove("hidden");
  });

  document.getElementById("copyMagicUrlBtn").addEventListener("click", async () => {
    const input = document.getElementById("magicLanUrlInput");
    try {
      await navigator.clipboard.writeText(input.value);
      showSecFeedback(t("fb_copied"));
    } catch (_) {
      input.select();
      document.execCommand("copy");
      showSecFeedback(t("fb_copied"));
    }
  });

  document.getElementById("rotateTokenBtn").addEventListener("click", async () => {
    if (!confirm(t("confirm_rotate_token"))) {
      return;
    }
    const res = await fetch("/api/auth/rotate-token", { method: "POST" });
    if (res.ok) {
      await loadStateFromServer();
      renderSecuritySection();
      showSecFeedback(t("fb_rotated"));
    }
  });

  document.getElementById("savePasswordBtn").addEventListener("click", async () => {
    const pw = document.getElementById("newPasswordInput").value.trim();
    if (pw.length < 4) {
      showSecFeedback(t("fb_pw_short"), true);
      return;
    }
    const res = await fetch("/api/auth/password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      document.getElementById("newPasswordInput").value = "";
      await loadStateFromServer();
      renderSecuritySection();
      showSecFeedback(t("fb_pw_saved"));
    } else {
      showSecFeedback(data.error || t("fb_pw_err"), true);
    }
  });

  document.getElementById("logoutDeviceBtn").addEventListener("click", async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.replace("/");
  });

  document.getElementById("closeSettingsBtn").addEventListener("click", () => {
    settingsModal.classList.add("hidden");
  });

  document.getElementById("addCatBtn").addEventListener("click", async () => {
    const icon = document.getElementById("newCatIcon").value.trim() || "🎵";
    const name = document.getElementById("newCatName").value.trim();
    if (!name) return;
    await fetch("/api/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ icon, name }),
    });
    document.getElementById("newCatName").value = "";
    await loadStateFromServer();
    renderSettingsCategories();
  });

  document.getElementById("saveSettingsBtn").addEventListener("click", async () => {
    const fade_in_duration = parseFloat(document.getElementById("setFadeIn").value || "1.5");
    const fade_out_duration = parseFloat(document.getElementById("setFadeOut").value || "2.0");
    const crossfade_duration = Math.max(1.0, Math.min(15.0, parseFloat(document.getElementById("setCrossfadeDur").value || "4.0")));
    const ducking_volume = Math.max(0, Math.min(0.9, parseFloat(document.getElementById("setDuckingVol").value || "20") / 100));
    const ducking_fade = parseFloat(document.getElementById("setDuckingFade").value || "0.6");
    const auth_enabled = document.getElementById("setAuthEnabled").checked;
    const auth_require_on_localhost = document.getElementById("setAuthLocalhost").checked;

    await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fade_in_duration: String(fade_in_duration),
        fade_out_duration: String(fade_out_duration),
        crossfade_duration: String(crossfade_duration),
        ducking_volume: String(ducking_volume),
        ducking_fade: String(ducking_fade),
        auth_enabled: String(auth_enabled),
        auth_require_on_localhost: String(auth_require_on_localhost),
      }),
    });

    await loadStateFromServer();
    settingsModal.classList.add("hidden");
  });
});

function roundToTenth(val) {
  return Math.round(val * 10) / 10;
}

/**
 * Universelles Touch- & Maus-Drag-and-Drop für die 3 Cockpit-Spalten
 * (Liste | Regler | Aktuelles Lied) inkl. weicher FLIP-Ausweichanimation!
 */
function initPanelDragAndDrop(workspace) {
  if (!workspace) return;

  let draggedPanel = null;
  let pointerId = null;
  let startClientX = 0;
  let startClientY = 0;
  let layoutAnchorLeft = 0;

  workspace.querySelectorAll(".panel-drag-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      // Nur im 3-Spalten-Modus (> 980px) und nicht bei Klick auf Buttons/Dropdowns im Header
      if (window.innerWidth <= 980) return;
      if (e.target.closest("button, select, input")) return;

      const panel = handle.closest(".cockpit-panel");
      if (!panel) return;

      draggedPanel = panel;
      pointerId = e.pointerId;
      startClientX = e.clientX;
      startClientY = e.clientY;
      layoutAnchorLeft = panel.getBoundingClientRect().left;

      panel.style.transition = "none";
      panel.classList.add("is-dragging-panel");
      try {
        handle.setPointerCapture(pointerId);
      } catch (_) {}
    });

    handle.addEventListener("pointermove", (e) => {
      if (!draggedPanel || e.pointerId !== pointerId) return;

      let dx = e.clientX - startClientX;
      const dy = (e.clientY - startClientY) * 0.14;
      draggedPanel.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.015)`;

      const draggedRect = draggedPanel.getBoundingClientRect();
      const draggedCenter = draggedRect.left + draggedRect.width / 2;

      const panels = Array.from(workspace.querySelectorAll(".cockpit-panel"));
      const curIdx = panels.indexOf(draggedPanel);

      // Prüfen, ob wir über die Mitte des linken oder rechten Nachbar-Panels ziehen
      let swapTarget = null;
      let insertBeforeNode = null;

      if (curIdx > 0) {
        const prev = panels[curIdx - 1];
        const prevRect = prev.getBoundingClientRect();
        if (draggedCenter < prevRect.left + prevRect.width * 0.52) {
          swapTarget = prev;
          insertBeforeNode = prev;
        }
      }

      if (!swapTarget && curIdx < panels.length - 1) {
        const next = panels[curIdx + 1];
        const nextRect = next.getBoundingClientRect();
        if (draggedCenter > nextRect.left + nextRect.width * 0.48) {
          swapTarget = next;
          insertBeforeNode = next.nextSibling;
        }
      }

      if (swapTarget) {
        // FLIP-Animation: alte Position des Nachbarn merken
        const swapOldLeft = swapTarget.getBoundingClientRect().left;
        draggedPanel.style.transform = "none";

        workspace.insertBefore(draggedPanel, insertBeforeNode);

        // Neue Layout-Position messen und Anker anpassen, damit das gezogene Panel am Finger klebt!
        const newAnchorLeft = draggedPanel.getBoundingClientRect().left;
        startClientX += newAnchorLeft - layoutAnchorLeft;
        layoutAnchorLeft = newAnchorLeft;

        dx = e.clientX - startClientX;
        draggedPanel.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.015)`;

        // Nachbar-Panel butterweich an seinen neuen Platz gleiten lassen
        const swapNewLeft = swapTarget.getBoundingClientRect().left;
        const invertX = swapOldLeft - swapNewLeft;
        swapTarget.style.transition = "none";
        swapTarget.style.transform = `translate3d(${invertX}px, 0, 0)`;
        requestAnimationFrame(() => {
          swapTarget.style.transition = "transform 260ms cubic-bezier(0.22, 1, 0.36, 1)";
          swapTarget.style.transform = "";
        });
      }
    });

    function finishPanelDrag(e) {
      if (!draggedPanel || e.pointerId !== pointerId) return;
      const panel = draggedPanel;
      draggedPanel = null;

      try {
        handle.releasePointerCapture(pointerId);
      } catch (_) {}
      pointerId = null;

      // Sanftes Einrasten in den Ziel-Slot
      panel.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
      panel.style.transform = "";
      panel.classList.remove("is-dragging-panel");

      const newOrder = Array.from(workspace.querySelectorAll(".cockpit-panel"))
        .map((el) => el.dataset.panelId)
        .join(",");

      if (newOrder && newOrder !== state.settings.panel_order) {
        state.settings.panel_order = newOrder;
        localStorage.setItem("arena_dj_panel_order", newOrder);
        fetch("/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ panel_order: newOrder }),
        });
      }
    }

    handle.addEventListener("pointerup", finishPanelDrag);
    handle.addEventListener("pointercancel", finishPanelDrag);
  });
}

/**
 * Universelles Touch- & Maus-Drag-and-Drop zum Umsortieren der Lieder
 * (funktioniert sowohl in der Listen-Ansicht als auch in der Kachel-Ansicht!)
 */
function bindTrackDragAndDrop(grid) {
  if (!grid) return;

  let draggedItem = null;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let anchorLeft = 0;
  let anchorTop = 0;

  grid.querySelectorAll(".track-drag-handle").forEach((handle) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();

      const item = handle.closest(".track-list-row, .track-card");
      if (!item) return;

      state.isDraggingTrack = true;
      draggedItem = item;
      pointerId = e.pointerId;
      startX = e.clientX;
      startY = e.clientY;
      const rect = item.getBoundingClientRect();
      anchorLeft = rect.left;
      anchorTop = rect.top;

      item.style.transition = "none";
      item.classList.add("is-dragging-track");

      try {
        handle.setPointerCapture(pointerId);
      } catch (_) {}
    });

    handle.addEventListener("pointermove", (e) => {
      if (!draggedItem || e.pointerId !== pointerId) return;

      // Automatisches Mitscrollen am oberen/unteren Rand des Scroll-Containers
      const viewport = document.getElementById("songsScrollViewport");
      if (viewport && window.innerWidth > 980) {
        const vpRect = viewport.getBoundingClientRect();
        const edgeZone = 52;
        if (e.clientY < vpRect.top + edgeZone && viewport.scrollTop > 0) {
          const step = Math.min(12, viewport.scrollTop);
          viewport.scrollTop -= step;
          anchorTop += step;
          startY += step;
        } else if (
          e.clientY > vpRect.bottom - edgeZone &&
          viewport.scrollTop < viewport.scrollHeight - viewport.clientHeight
        ) {
          const step = 12;
          viewport.scrollTop += step;
          anchorTop -= step;
          startY -= step;
        }
      }

      let dx = e.clientX - startX;
      let dy = e.clientY - startY;
      const isListMode = state.settings.view_mode === "list";
      if (isListMode) {
        dx *= 0.15;
      }
      draggedItem.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.015)`;

      const items = Array.from(grid.querySelectorAll(":scope > [data-track-id]"));
      const curIdx = items.indexOf(draggedItem);
      if (curIdx === -1) return;

      let targetItem = null;
      for (let i = 0; i < items.length; i++) {
        if (i === curIdx) continue;
        const r = items[i].getBoundingClientRect();
        if (isListMode) {
          const midY = r.top + r.height / 2;
          if ((i < curIdx && e.clientY < midY) || (i > curIdx && e.clientY > midY)) {
            targetItem = items[i];
            if (i < curIdx) break;
          }
        } else {
          if (
            e.clientX >= r.left &&
            e.clientX <= r.right &&
            e.clientY >= r.top &&
            e.clientY <= r.bottom
          ) {
            targetItem = items[i];
            break;
          }
        }
      }

      if (targetItem) {
        const targetIdx = items.indexOf(targetItem);
        const oldPositions = new Map();
        items.forEach((el) => {
          if (el !== draggedItem) {
            const r = el.getBoundingClientRect();
            oldPositions.set(el, { left: r.left, top: r.top });
          }
        });

        draggedItem.style.transform = "none";
        const refNode = curIdx < targetIdx ? targetItem.nextSibling : targetItem;
        grid.insertBefore(draggedItem, refNode);

        const newDragRect = draggedItem.getBoundingClientRect();
        startX += newDragRect.left - anchorLeft;
        startY += newDragRect.top - anchorTop;
        anchorLeft = newDragRect.left;
        anchorTop = newDragRect.top;

        dx = e.clientX - startX;
        dy = e.clientY - startY;
        if (isListMode) dx *= 0.15;
        draggedItem.style.transform = `translate3d(${dx}px, ${dy}px, 0) scale(1.015)`;

        // FLIP-Animation für alle verschobenen Nachbar-Lieder
        oldPositions.forEach((oldPos, el) => {
          const newPos = el.getBoundingClientRect();
          const invX = oldPos.left - newPos.left;
          const invY = oldPos.top - newPos.top;
          if (Math.abs(invX) > 0.5 || Math.abs(invY) > 0.5) {
            el.style.transition = "none";
            el.style.transform = `translate3d(${invX}px, ${invY}px, 0)`;
            requestAnimationFrame(() => {
              el.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
              el.style.transform = "";
            });
          }
        });
      }
    });

    async function finishTrackDrag(e) {
      if (!draggedItem || e.pointerId !== pointerId) return;
      const item = draggedItem;
      draggedItem = null;

      try {
        handle.releasePointerCapture(pointerId);
      } catch (_) {}
      pointerId = null;

      item.style.transition = "transform 200ms cubic-bezier(0.22, 1, 0.36, 1)";
      item.style.transform = "";
      item.classList.remove("is-dragging-track");
      state.isDraggingTrack = false;

      // Neue Reihenfolge aus dem DOM auslesen
      const visibleIds = Array.from(grid.querySelectorAll(":scope > [data-track-id]")).map((el) =>
        Number(el.dataset.trackId)
      );

      if (state.activeCategory === "all") {
        const byId = new Map(state.tracks.map((t) => [t.id, t]));
        const reordered = [];
        visibleIds.forEach((id) => {
          if (byId.has(id)) {
            reordered.push(byId.get(id));
            byId.delete(id);
          }
        });
        byId.forEach((t) => reordered.push(t));
        state.tracks = reordered;
      } else {
        // Nur die Lieder der aktiven Kategorie an ihren Positionen umsortieren
        const byId = new Map(state.tracks.map((t) => [t.id, t]));
        const reorderedCatTracks = visibleIds.map((id) => byId.get(id)).filter(Boolean);
        let catPtr = 0;
        state.tracks = state.tracks.map((t) => {
          if (t.category_id === state.activeCategory && catPtr < reorderedCatTracks.length) {
            return reorderedCatTracks[catPtr++];
          }
          return t;
        });
      }

      updatePlayerUI();

      // Neue Reihenfolge dauerhaft in SQLite speichern
      const allIds = state.tracks.map((t) => t.id);
      await fetch("/api/tracks/reorder", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ track_ids: allIds }),
      });
    }

    handle.addEventListener("pointerup", finishTrackDrag);
    handle.addEventListener("pointercancel", finishTrackDrag);
  });
}
