/**
 * Arena DJ Soundboard – Mehrsprachigkeit (Deutsch, English, Français)
 */

const SUPPORTED_LANGUAGES = ["de", "en", "fr"];

const DEFAULT_CATEGORY_TRANSLATIONS = {
  action: {
    de: "Zwischen Athleten",
    en: "Between Athletes",
    fr: "Entre les athlètes",
  },
  walkin: {
    de: "Einlauf / Start",
    en: "Walk-In / Start",
    fr: "Entrée / Départ",
  },
  tension: {
    de: "Spannung / Finale",
    en: "Tension / Final",
    fr: "Suspense / Finale",
  },
  jingles: {
    de: "Jingles & Effekte",
    en: "Jingles & Effects",
    fr: "Jingles & Effets",
  },
  ceremony: {
    de: "Siegerehrung & Pause",
    en: "Award Ceremony & Break",
    fr: "Cérémonie & Pause",
  },
};

const TRANSLATIONS = {
  de: {
    page_title: "Arena DJ Soundboard – Wettkampf-Musiksteuerung",
    resume_banner_default: "▶️ Wiedergabe lief vor dem Neuladen – antippen zum nahtlosen Fortsetzen!",
    resume_dynamic: "▶️ „{title}“ lief vor dem Neuladen ({time}) – 1× tippen zum Weiterhören!",
    resume_btn: "▶️ Sofort fortsetzen",
    brand_sub: "Wettkampf-Soundboard",
    output_group_aria: "Ton-Ausgabe wählen",
    out_server_label: "🔊 Server-Ton",
    out_server_title: "Ton läuft zentral über den Server-PC (Hallen-Anlage) – Neuladen auf iPad/Handy unterbricht den Ton NIEMALS!",
    out_local_label: "📱 Gerät-Ton",
    out_local_title: "Ton kommt direkt aus diesem Gerät/Browser (inkl. Reload-Warnung & Fortsetzen-Schutz)",
    search_placeholder: "Lied / Highlight suchen...",
    settings_btn_title: "Einstellungen",
    upload_btn_title: "Neue MP3-Lieder hochladen",
    upload_btn_aria: "MP3 hochladen",

    // Cockpit Panels & Drag
    panel_drag_title: "Gedrückt halten & ziehen zum Verschieben",
    movable_pill: "Verschiebbar",
    panel_songs_title: "🎵 LIEDER & HIGHLIGHTS",
    panel_fader_title: "🎚️ MASTER-REGLER",
    panel_deck_title: "💿 AKTUELLES LIED",

    // Songs Panel Header & Content
    cat_select_title: "Kategorie filtern",
    cat_select_aria: "Kategorie wählen",
    cat_all: "🏆 Alle Lieder",
    view_group_aria: "Ansicht wählen",
    view_grid_title: "Kachel-Ansicht",
    view_list_title: "Listen-Ansicht",
    autofollow_aria: "Auto-Mitlauf",
    autofollow_on_title: "Auto-Mitlauf aktiv: Liste läuft bei Liedwechsel automatisch zum aktiven Titel mit",
    autofollow_off_title: "Auto-Mitlauf deaktiviert (manuelles Scrollen)",
    shuffle_aria: "Zufallswiedergabe (Shuffle)",
    shuffle_on_title: "Shuffle aktiv: Nächstes Lied wird zufällig ausgewählt",
    shuffle_off_title: "Shuffle deaktiviert (Reihenfolge nach Liste)",

    drop_title: "MP3 / Audio-Dateien hier ablegen",
    drop_sub_default: "Zuordnung zur ausgewählten Kategorie",
    drop_sub_fallback: "Zuordnung zu Standard-Kategorie: {icon} {name}",
    drop_sub_assigned: "Wird zugeordnet zu: {icon} {name}",
    drop_err_no_audio: "⚠️ Keine Audio-Datei erkannt (bitte MP3, WAV, M4A, OGG oder FLAC hineinziehen).",
    drop_uploading_one: "⏳ Lade 1 Lied in „{icon} {name}“ hoch & analysiere Wellenform...",
    drop_uploading_many: "⏳ Lade {count} Lieder in „{icon} {name}“ hoch & analysiere Wellenform...",
    drop_done_one: "✅ 1 Lied zu „{icon} {name}“ hinzugefügt!",
    drop_done_many: "✅ {count} Lieder zu „{icon} {name}“ hinzugefügt!",
    drop_err_upload: "⚠️ Fehler beim Hochladen: {err}",

    empty_tracks_title: "Keine Lieder in dieser Ansicht gefunden",
    empty_tracks_sub: "Ziehe MP3-Dateien einfach per Drag & Drop hierher oder nutze den Upload-Button oben rechts.",
    track_drag_title: "Gedrückt halten & ziehen zum Umsortieren",
    play_from_start_title: "Lied ab Anfang (0:00) starten",
    default_artist: "Wettkampf-Track",
    cue_btn_tip: "{num}: {label} (ab {time})",
    loop_active_title: "Endlosschleife aktiv (Ein/Aus)",
    loop_inactive_title: "Als Endlosschleife markieren (Ein/Aus)",
    loop_aria: "Endlosschleife",
    edit_cues_title: "Highlights & Wellenform bearbeiten",
    edit_waveform_title: "Highlights & Wellenform öffnen",

    // Master Fader & Talkover
    master_vol_title: "MASTER LAUTSTÄRKE",
    master_vol_aria: "Master Lautstärke",
    eff_talkover: "🎤 Durchsage aktiv – gedämpft ({pct}%)",
    eff_fading_out: "📉 Blendet sanft aus... ({pct}%)",
    eff_crossfading: "🔀 Crossfade zum nächsten Lied ({pct}%)",
    eff_output: "Ausgangspegel: {pct}%",
    srv_eff_talkover: "🎤 Server-Durchsage aktiv ({pct}%)",
    srv_eff_fading_out: "📉 Server blendet aus... ({pct}%)",
    srv_eff_crossfading: "🔀 Server-Crossfade läuft ({pct}%)",
    srv_eff_output: "🔊 Server-Pegel: {pct}%",
    badge_on: "AKTIV",
    badge_off: "AUS",
    talkover_title: "DURCHSAGE / TALKOVER",
    talkover_desc: "Musik sanft auf {pct}% absenken",
    autofade_label: "Auto-Fade",
    autonext_label: "Automatisch nächstes Lied",
    shuffle_label: "🔀 Zufallswiedergabe (Shuffle)",
    crossfade_label: "Crossfade",

    // Now Playing Deck & Mobile Dock
    deck_ready: "Bereit für nächsten Einsatz",
    deck_paused: "Pausiert / Bereit",
    deck_playing: "Läuft gerade in der Halle",
    deck_fading: "Blendet sanft aus...",
    deck_crossfading: "🔀 Überblendung ins nächste Lied...",
    np_loop_title: "Aktuelles Lied als Endlosschleife wiederholen",
    np_loop_on: "🔁 Endlos: AN",
    np_loop_off: "🔁 Endlos: AUS",
    np_no_track: "Kein Lied geladen",
    np_tap_hint: "Tippe auf ein Highlight-Pad zum Starten",
    np_active_cue: "Aktives Highlight: {label} ({time})",
    np_from_start: "Ab Anfang",
    np_from_start_cue: "▶ Ab Anfang",
    np_next_loop: "🔁 Endlosschleife aktiv (wiederholt diesen Titel)",
    np_next_xfade: "🔀 Crossfade",
    np_next_after: "⏭ Danach",
    np_next_shuffle: "🔀 Zufall",
    np_next_shuffle_xfade: "🔀 Zufall (Crossfade)",
    np_next_stop: "⏹ Stoppt am Liedende",
    skip_next_btn: "⏭ Nächstes",
    skip_next_title: "Sofort zum nächsten Lied springen",
    np_waveform_title: "Tippen zum Springen im Lied",
    play_start: "START",
    play_pause: "PAUSE",
    play_resume: "WEITER",
    fade_out_btn: "SANFT AUSBLENDEN",
    fade_out_sub: "{sec}s Fade-Out",
    stop_immediate_btn: "SOFORT-STOP",

    mob_mode_server: "🔊 Server",
    mob_mode_local: "📱 Gerät",
    mob_paused: "Pausiert",
    mob_ready_server: "🔊 Server bereit",
    mob_ready_local: "📱 Gerät bereit",
    mob_play_title: "Start / Pause",
    mob_fade_title: "Sanft ausblenden",
    mob_talk_title: "Durchsage / Talkover",
    mob_tab_songs: "🎵 Liste",
    mob_tab_fader_prefix: "🎚️ Regler",
    mob_tab_deck: "💿 Aktuell",

    // Editor Modal
    editor_title_default: "Highlights & Wellenform bearbeiten",
    editor_title_prefix: "✂️ Highlights & Waveform: {title}",
    editor_subtitle: "Tippe in die Wellenform zum Vorhören und setze beliebige Start-Highlights für den Wettkampf.",
    meta_title_label: "Lied-Titel",
    meta_title_ph: "Titel",
    meta_artist_label: "Interpret / Notiz",
    meta_artist_ph: "Interpret / Hinweis",
    meta_cat_label: "Kategorie",
    meta_vol_label: "Song-Lautstärke",
    meta_loop_label: "Endlos-Loop",
    meta_loop_no: "Nein",
    meta_loop_yes: "Ja (Loop)",
    meta_save_btn: "💾 Speichern",
    editor_preview_play: "▶ Hier vorhören",
    editor_preview_stop: "⏸ Vorhören stoppen",
    editor_back_title: "2 Sekunden zurück",
    editor_fwd_title: "2 Sekunden vor",
    editor_pos_label: "Position:",
    editor_mark_btn: "📍 Aktuelle Position als Highlight speichern",
    editor_cues_heading: "Gespeicherte Highlights (Schnellstart-Buttons für dieses Lied)",
    editor_no_cues: "Noch keine Highlights angelegt. Tippe oben auf „📍 Aktuelle Position als Highlight speichern“.",
    cue_color_title: "Farbe für Button {num}",
    cue_btn_label_prefix: "Button",
    cue_btn_label_suffix: "– Notiz / Bezeichnung",
    cue_label_ph: "z. B. Refrain / Drop",
    cue_start_label: "Startzeit (Sekunden)",
    cue_use_cursor_title: "Aktuelle Wellenform-Position übernehmen",
    cue_end_label: "Optionales Ende (Sek.)",
    cue_end_ph: "Bis Liedende",
    cue_fade_title: "Sanft einblenden oder sofort mit 100% Lautstärke starten",
    cue_fade_label: "Fade-In",
    cue_test_btn: "▶ Test",
    cue_test_title: "Ab diesem Highlight vorhören",
    cue_del_title: "Highlight löschen",
    delete_track_btn: "🗑️ Lied komplett löschen",
    done_editor_btn: "Fertig & Schließen",
    confirm_delete_track: "Möchtest du „{title}“ wirklich dauerhaft löschen?",
    unnamed_track: "Unbenannt",

    // Upload Modal
    upload_modal_title: "➕ MP3 / Audio-Dateien hinzufügen",
    upload_modal_sub: "Hochgeladene Lieder werden dauerhaft auf dem Server gespeichert und stehen auch beim nächsten Wettkampf bereit.",
    dropzone_title: "MP3-Dateien hier ablegen oder antippen zum Auswählen",
    dropzone_sub_default: "Mehrfachauswahl möglich (MP3, WAV, M4A, OGG)",
    dropzone_files_selected: "{count} Datei(en) ausgewählt: {names}",
    upload_cat_label: "Kategorie zuweisen",
    upload_color_label: "Standard-Farbe",
    upload_progress_text: "Lieder werden hochgeladen und Wellenform wird analysiert...",
    cancel_btn: "Abbrechen",
    submit_upload_btn: "⬆️ Jetzt hochladen & speichern",
    err_upload_alert: "Fehler beim Hochladen: {err}",

    // Settings Modal
    settings_title: "⚙️ Einstellungen",
    settings_subtitle: "Design, Sprache, WLAN-Zugang (QR / PIN), Überblend-Zeiten, Kategorien und Software-Update.",
    theme_heading: "🎛️ Erscheinungsbild / Design",
    theme_sub: "Wähle zwischen einem dezenten, professionellen Studio-Mischpult-Look und dem farbigen Wettkampf-Design:",
    theme_studio_btn: "🎛️ Studio Pro (Dezent)",
    theme_arena_btn: "🏟️ Arena Klassik (Farbig)",
    lang_heading: "🌐 Sprache",
    lang_sub: "Alle Bezeichnungen der Oberfläche sofort in der gewählten Sprache anzeigen:",

    sec_header: "🔒 Geschützter WLAN-Zugang (iPad / Handy)",
    sec_protected: "🔒 GESCHÜTZT",
    sec_open: "🔓 OFFEN",
    qr_alt: "QR-Code für iPad-Direktzugang",
    qr_caption: "📱 Mit iPad-Kamera scannen",
    sec_way1_label: "1. QR-Code scannen oder geheimen Direktlink nutzen (inkl. Token):",
    copy_btn: "📋 Kopieren",
    rotate_btn: "🔄 Neu",
    rotate_title: "Erzeugt sofort einen neuen Link + neuen QR-Code und sperrt den alten",
    lan_hint: "Einfach mit der Kamera-App vom iPad/Handy abfotografieren/scannen → sofort ohne Passwort-Tippen für 30 Tage eingeloggt!",
    sec_way2_label: "2. Oder kurze WLAN-Adresse aufrufen & Passwort / PIN eingeben:",
    address_label: "Adresse:",
    pin_initial: "Aktuelle Start-PIN: {pin}",
    pin_custom: "✅ Eigenes Passwort / PIN aktiv",
    new_pw_ph: "Eigenes Passwort / neue PIN (mind. 4 Zeichen)",
    save_pw_btn: "🔑 Passwort setzen",
    sec_auth_enabled_label: "Zugriffsschutz im WLAN aktivieren (Fremde kommen ohne Token/Passwort nicht rein)",
    sec_auth_localhost_label: "Passwort auch direkt an diesem Server-PC (localhost) verlangen",
    fb_copied: "✅ Geheimer Direktlink in die Zwischenablage kopiert!",
    confirm_rotate_token: "Neuen geheimen Link erzeugen? Der bisherige Link wird sofort ungültig und fremde Geräte werden abgemeldet.",
    fb_rotated: "🔄 Neuer geheimer Token-Link wurde erzeugt! Alte Links sind gesperrt.",
    fb_pw_short: "⚠️ Bitte mindestens 4 Zeichen als Passwort / PIN eingeben.",
    fb_pw_saved: "✅ Neues Passwort / PIN wurde gespeichert!",
    fb_pw_err: "Fehler beim Speichern.",

    set_fade_in_label: "Fade-In beim Start (Sek.)",
    set_fade_out_label: "Fade-Out beim Stopp (Sek.)",
    set_xfade_label: "Crossfade / Überblenden (Sek.)",
    set_duck_vol_label: "Talkover / Durchsage-Lautstärke (%)",
    set_duck_fade_label: "Talkover Übergangszeit (Sekunden)",

    manage_cats_heading: "Kategorien verwalten",
    del_cat_title: "Kategorie löschen",
    new_cat_ph: "Neue Kategorie (z. B. Halbfinale)",
    add_cat_btn: "+ Hinzufügen",

    update_heading: "🔄 Software-Update (GitHub)",
    version_local_badge: "Lokale Version",
    version_commit_badge: "Commit {short}",
    version_details_git: "Installierter Stand: {short} ({date}) – „{subject}“. Lieder & Datenbank bleiben bei Updates unberührt.",
    version_details_fallback: "Prüfe bei Bedarf, ob auf GitHub eine neuere Version verfügbar ist. Deine Lieder, Highlights und Einstellungen bleiben beim Update vollständig erhalten.",
    check_update_btn: "🔍 Auf neue Version prüfen",
    checking_update_btn: "⏳ Prüfe auf GitHub...",
    install_update_btn: "⬇️ Jetzt direkt updaten",
    installing_update_btn: "⏳ Update läuft...",
    update_checking_msg: "Verbinde mit GitHub und prüfe auf neue Version...",
    update_available_one: "🚀 Neue Version auf GitHub verfügbar! (1 Änderung – neuester Stand: {short})",
    update_available_many: "🚀 Neue Version auf GitHub verfügbar! ({count} Änderungen – neuester Stand: {short})",
    update_up_to_date_msg: "✅ Du nutzt bereits die aktuellste Version ({short}).",
    update_check_failed: "Update-Prüfung fehlgeschlagen.",
    update_conn_err: "⚠️ Fehler bei der Verbindung zum Server: {err}",
    confirm_update_playing: "Hinweis: Es läuft gerade Musik. Falls beim Update Server-Dateien erneuert werden, startet der Server für ca. 1–2 Sekunden neu. Jetzt direkt updaten?",
    update_downloading_msg: "⏳ Lade neue Version von GitHub herunter und installiere Update...",
    update_install_failed: "Update konnte nicht installiert werden.",
    update_restarting_msg: "✅ Auf Version {short} aktualisiert! Server startet kurz neu – Oberfläche lädt automatisch neu...",
    update_done_reload_msg: "✅ Update installiert ({short})! Oberfläche wird neu geladen...",
    update_fast_restart_msg: "🔄 Server startet neu – Oberfläche wird gleich automatisch neu geladen...",

    backup_btn: "📦 Einstellungen & Highlights als Backup herunterladen",
    logout_btn: "🔒 Gerät abmelden",
    logout_title: "Dieses Gerät abmelden und sperren",
    save_settings_btn: "💾 Einstellungen speichern",
    beforeunload_msg: "Musik läuft gerade live (ON AIR)!",
  },

  en: {
    page_title: "Arena DJ Soundboard – Competition Music Control",
    resume_banner_default: "▶️ Playback was running before reload – tap to resume seamlessly!",
    resume_dynamic: "▶️ “{title}” was playing before reload ({time}) – tap once to resume!",
    resume_btn: "▶️ Resume now",
    brand_sub: "Competition Soundboard",
    output_group_aria: "Select audio output",
    out_server_label: "🔊 Server Audio",
    out_server_title: "Audio plays centrally on the server PC (venue PA) – reloading on iPad/phone NEVER interrupts the music!",
    out_local_label: "📱 Device Audio",
    out_local_title: "Audio plays directly on this device/browser (includes reload warning & resume protection)",
    search_placeholder: "Search track / highlight...",
    settings_btn_title: "Settings",
    upload_btn_title: "Upload new MP3 tracks",
    upload_btn_aria: "Upload MP3",

    // Cockpit Panels & Drag
    panel_drag_title: "Hold & drag to rearrange",
    movable_pill: "Draggable",
    panel_songs_title: "🎵 TRACKS & HIGHLIGHTS",
    panel_fader_title: "🎚️ MASTER FADER",
    panel_deck_title: "💿 NOW PLAYING",

    // Songs Panel Header & Content
    cat_select_title: "Filter category",
    cat_select_aria: "Select category",
    cat_all: "🏆 All Tracks",
    view_group_aria: "Select view mode",
    view_grid_title: "Grid view",
    view_list_title: "List view",
    autofollow_aria: "Auto-follow",
    autofollow_on_title: "Auto-follow active: list automatically scrolls to the playing track",
    autofollow_off_title: "Auto-follow disabled (manual scrolling)",
    shuffle_aria: "Shuffle playback",
    shuffle_on_title: "Shuffle active: next track is chosen randomly",
    shuffle_off_title: "Shuffle disabled (sequential order)",

    drop_title: "Drop MP3 / audio files here",
    drop_sub_default: "Assigned to the selected category",
    drop_sub_fallback: "Assigned to default category: {icon} {name}",
    drop_sub_assigned: "Will be assigned to: {icon} {name}",
    drop_err_no_audio: "⚠️ No audio file detected (please drop MP3, WAV, M4A, OGG, or FLAC files).",
    drop_uploading_one: "⏳ Uploading 1 track to “{icon} {name}” & analyzing waveform...",
    drop_uploading_many: "⏳ Uploading {count} tracks to “{icon} {name}” & analyzing waveforms...",
    drop_done_one: "✅ 1 track added to “{icon} {name}”!",
    drop_done_many: "✅ {count} tracks added to “{icon} {name}”!",
    drop_err_upload: "⚠️ Upload failed: {err}",

    empty_tracks_title: "No tracks found in this view",
    empty_tracks_sub: "Simply drag & drop MP3 files here or use the upload button at the top right.",
    track_drag_title: "Hold & drag to reorder",
    play_from_start_title: "Play track from beginning (0:00)",
    default_artist: "Competition Track",
    cue_btn_tip: "{num}: {label} (from {time})",
    loop_active_title: "Endless loop active (On/Off)",
    loop_inactive_title: "Mark as endless loop (On/Off)",
    loop_aria: "Endless loop",
    edit_cues_title: "Edit highlights & waveform",
    edit_waveform_title: "Open highlights & waveform",

    // Master Fader & Talkover
    master_vol_title: "MASTER VOLUME",
    master_vol_aria: "Master Volume",
    eff_talkover: "🎤 Talkover active – ducked ({pct}%)",
    eff_fading_out: "📉 Smoothly fading out... ({pct}%)",
    eff_crossfading: "🔀 Crossfading to next track ({pct}%)",
    eff_output: "Output level: {pct}%",
    srv_eff_talkover: "🎤 Server talkover active ({pct}%)",
    srv_eff_fading_out: "📉 Server fading out... ({pct}%)",
    srv_eff_crossfading: "🔀 Server crossfade running ({pct}%)",
    srv_eff_output: "🔊 Server level: {pct}%",
    badge_on: "ON",
    badge_off: "OFF",
    talkover_title: "ANNOUNCEMENT / TALKOVER",
    talkover_desc: "Smoothly duck music to {pct}%",
    autofade_label: "Auto-Fade",
    autonext_label: "Auto-play next track",
    shuffle_label: "🔀 Shuffle playback",
    crossfade_label: "Crossfade",

    // Now Playing Deck & Mobile Dock
    deck_ready: "Ready for next cue",
    deck_paused: "Paused / Ready",
    deck_playing: "Playing live in venue",
    deck_fading: "Smoothly fading out...",
    deck_crossfading: "🔀 Crossfading into next track...",
    np_loop_title: "Repeat current track in an endless loop",
    np_loop_on: "🔁 Loop: ON",
    np_loop_off: "🔁 Loop: OFF",
    np_no_track: "No track loaded",
    np_tap_hint: "Tap a track or highlight pad to start",
    np_active_cue: "Active highlight: {label} ({time})",
    np_from_start: "From beginning",
    np_from_start_cue: "▶ From beginning",
    np_next_loop: "🔁 Endless loop active (repeating this track)",
    np_next_xfade: "🔀 Crossfade",
    np_next_after: "⏭ Up next",
    np_next_shuffle: "🔀 Shuffle",
    np_next_shuffle_xfade: "🔀 Shuffle (Crossfade)",
    np_next_stop: "⏹ Stops at end of track",
    skip_next_btn: "⏭ Next",
    skip_next_title: "Skip immediately to the next track",
    np_waveform_title: "Tap to seek within track",
    play_start: "PLAY",
    play_pause: "PAUSE",
    play_resume: "RESUME",
    fade_out_btn: "SMOOTH FADE OUT",
    fade_out_sub: "{sec}s Fade-Out",
    stop_immediate_btn: "INSTANT STOP",

    mob_mode_server: "🔊 Server",
    mob_mode_local: "📱 Device",
    mob_paused: "Paused",
    mob_ready_server: "🔊 Server ready",
    mob_ready_local: "📱 Device ready",
    mob_play_title: "Play / Pause",
    mob_fade_title: "Smooth fade out",
    mob_talk_title: "Announcement / Talkover",
    mob_tab_songs: "🎵 Tracks",
    mob_tab_fader_prefix: "🎚️ Fader",
    mob_tab_deck: "💿 Playing",

    // Editor Modal
    editor_title_default: "Edit Highlights & Waveform",
    editor_title_prefix: "✂️ Highlights & Waveform: {title}",
    editor_subtitle: "Click or drag on the waveform to preview and save custom start highlights for the competition.",
    meta_title_label: "Track Title",
    meta_title_ph: "Title",
    meta_artist_label: "Artist / Note",
    meta_artist_ph: "Artist / Hint",
    meta_cat_label: "Category",
    meta_vol_label: "Track Volume",
    meta_loop_label: "Endless Loop",
    meta_loop_no: "No",
    meta_loop_yes: "Yes (Loop)",
    meta_save_btn: "💾 Save",
    editor_preview_play: "▶ Preview here",
    editor_preview_stop: "⏸ Stop preview",
    editor_back_title: "Back 2 seconds",
    editor_fwd_title: "Forward 2 seconds",
    editor_pos_label: "Position:",
    editor_mark_btn: "📍 Save current position as highlight",
    editor_cues_heading: "Saved Highlights (Quick-launch buttons for this track)",
    editor_no_cues: "No highlights saved yet. Tap “📍 Save current position as highlight” above.",
    cue_color_title: "Color for button {num}",
    cue_btn_label_prefix: "Button",
    cue_btn_label_suffix: "– Note / Label",
    cue_label_ph: "e.g. Chorus / Drop",
    cue_start_label: "Start time (seconds)",
    cue_use_cursor_title: "Use current waveform cursor position",
    cue_end_label: "Optional end (sec.)",
    cue_end_ph: "Until track end",
    cue_fade_title: "Fade in smoothly or drop immediately at 100% volume",
    cue_fade_label: "Fade-In",
    cue_test_btn: "▶ Test",
    cue_test_title: "Preview from this highlight",
    cue_del_title: "Delete highlight",
    delete_track_btn: "🗑️ Delete track permanently",
    done_editor_btn: "Done & Close",
    confirm_delete_track: "Do you really want to permanently delete “{title}”?",
    unnamed_track: "Untitled",

    // Upload Modal
    upload_modal_title: "➕ Add MP3 / Audio Files",
    upload_modal_sub: "Uploaded tracks are stored permanently on the server and remain ready for future competitions.",
    dropzone_title: "Drop MP3 files here or tap to select",
    dropzone_sub_default: "Multiple files supported (MP3, WAV, M4A, OGG)",
    dropzone_files_selected: "{count} file(s) selected: {names}",
    upload_cat_label: "Assign category",
    upload_color_label: "Default color",
    upload_progress_text: "Uploading tracks and analyzing waveform...",
    cancel_btn: "Cancel",
    submit_upload_btn: "⬆️ Upload & save now",
    err_upload_alert: "Upload error: {err}",

    // Settings Modal
    settings_title: "⚙️ Settings",
    settings_subtitle: "Design, language, Wi-Fi access (QR / PIN), fade timings, categories, and GitHub software updates.",
    theme_heading: "🎛️ Appearance / Theme",
    theme_sub: "Choose between a subtle, professional studio mixer look and the colorful competition design:",
    theme_studio_btn: "🎛️ Studio Pro (Subtle)",
    theme_arena_btn: "🏟️ Arena Classic (Colorful)",
    lang_heading: "🌐 Language",
    lang_sub: "Switch all interface labels and messages immediately to your preferred language:",

    sec_header: "🔒 Protected Wi-Fi Access (iPad / Smartphone)",
    sec_protected: "🔒 PROTECTED",
    sec_open: "🔓 OPEN",
    qr_alt: "QR code for direct iPad access",
    qr_caption: "📱 Scan with iPad camera",
    sec_way1_label: "1. Scan QR code or use secret direct link (incl. token):",
    copy_btn: "📋 Copy",
    rotate_btn: "🔄 New",
    rotate_title: "Generates a new link + QR code immediately and revokes the old one",
    lan_hint: "Simply scan with your iPad/phone camera app → logged in instantly for 30 days without typing a password!",
    sec_way2_label: "2. Or open short Wi-Fi URL & enter password / PIN:",
    address_label: "Address:",
    pin_initial: "Current initial PIN: {pin}",
    pin_custom: "✅ Custom password / PIN active",
    new_pw_ph: "Custom password / new PIN (min. 4 chars)",
    save_pw_btn: "🔑 Set password",
    sec_auth_enabled_label: "Enable Wi-Fi access protection (strangers cannot enter without token/password)",
    sec_auth_localhost_label: "Also require password directly on this server PC (localhost)",
    fb_copied: "✅ Secret direct link copied to clipboard!",
    confirm_rotate_token: "Generate a new secret link? The previous link becomes invalid immediately and other devices will be logged out.",
    fb_rotated: "🔄 New secret token link generated! Old links are revoked.",
    fb_pw_short: "⚠️ Please enter at least 4 characters for the password / PIN.",
    fb_pw_saved: "✅ New password / PIN saved!",
    fb_pw_err: "Error saving password.",

    set_fade_in_label: "Fade-In on start (sec.)",
    set_fade_out_label: "Fade-Out on stop (sec.)",
    set_xfade_label: "Crossfade duration (sec.)",
    set_duck_vol_label: "Talkover / ducking volume (%)",
    set_duck_fade_label: "Talkover transition time (seconds)",

    manage_cats_heading: "Manage Categories",
    del_cat_title: "Delete category",
    new_cat_ph: "New category (e.g. Semifinal)",
    add_cat_btn: "+ Add",

    update_heading: "🔄 Software Update (GitHub)",
    version_local_badge: "Local version",
    version_commit_badge: "Commit {short}",
    version_details_git: "Installed build: {short} ({date}) – “{subject}”. Tracks & database remain untouched during updates.",
    version_details_fallback: "Check whether a newer version is available on GitHub. Your tracks, highlights, and settings remain completely untouched.",
    check_update_btn: "🔍 Check for new version",
    checking_update_btn: "⏳ Checking GitHub...",
    install_update_btn: "⬇️ Update now",
    installing_update_btn: "⏳ Updating...",
    update_checking_msg: "Connecting to GitHub and checking for updates...",
    update_available_one: "🚀 New version available on GitHub! (1 change – latest: {short})",
    update_available_many: "🚀 New version available on GitHub! ({count} changes – latest: {short})",
    update_up_to_date_msg: "✅ You are already running the latest version ({short}).",
    update_check_failed: "Update check failed.",
    update_conn_err: "⚠️ Server connection error: {err}",
    confirm_update_playing: "Note: Music is currently playing. If server files are updated, the server will restart briefly (~1–2 sec). Update now?",
    update_downloading_msg: "⏳ Downloading new version from GitHub and installing update...",
    update_install_failed: "Update could not be installed.",
    update_restarting_msg: "✅ Updated to version {short}! Server is restarting briefly – page will reload automatically...",
    update_done_reload_msg: "✅ Update installed ({short})! Reloading interface...",
    update_fast_restart_msg: "🔄 Server is restarting – interface will reload automatically...",

    backup_btn: "📦 Download settings & highlights backup",
    logout_btn: "🔒 Log out device",
    logout_title: "Log out and lock this device",
    save_settings_btn: "💾 Save settings",
    beforeunload_msg: "Music is currently playing live (ON AIR)!",
  },

  fr: {
    page_title: "Arena DJ Soundboard – Régie musicale de compétition",
    resume_banner_default: "▶️ La lecture était en cours avant le rechargement – appuyez pour reprendre sans coupure !",
    resume_dynamic: "▶️ « {title} » était en cours ({time}) – appuyez une fois pour reprendre !",
    resume_btn: "▶️ Reprendre",
    brand_sub: "Soundboard de compétition",
    output_group_aria: "Choisir la sortie audio",
    out_server_label: "🔊 Son Serveur",
    out_server_title: "Le son sort sur le PC serveur (sono de la salle) – recharger la page sur iPad/mobile ne coupe JAMAIS la musique !",
    out_local_label: "📱 Son Appareil",
    out_local_title: "Le son sort directement sur cet appareil/navigateur (avec alerte de rechargement et reprise rapide)",
    search_placeholder: "Rechercher titre / repère...",
    settings_btn_title: "Paramètres",
    upload_btn_title: "Importer de nouveaux titres MP3",
    upload_btn_aria: "Importer MP3",

    // Cockpit Panels & Drag
    panel_drag_title: "Maintenir et glisser pour déplacer",
    movable_pill: "Déplaçable",
    panel_songs_title: "🎵 TITRES & MOMENTS FORTS",
    panel_fader_title: "🎚️ FADER PRINCIPAL",
    panel_deck_title: "💿 EN COURS",

    // Songs Panel Header & Content
    cat_select_title: "Filtrer par catégorie",
    cat_select_aria: "Choisir une catégorie",
    cat_all: "🏆 Tous les titres",
    view_group_aria: "Choisir l'affichage",
    view_grid_title: "Vue en tuiles",
    view_list_title: "Vue en liste",
    autofollow_aria: "Suivi automatique",
    autofollow_on_title: "Suivi auto actif : la liste défile automatiquement vers le titre en cours",
    autofollow_off_title: "Suivi auto désactivé (défilement manuel)",
    shuffle_aria: "Lecture aléatoire (Shuffle)",
    shuffle_on_title: "Mode aléatoire actif : le titre suivant est choisi au hasard",
    shuffle_off_title: "Mode aléatoire désactivé (ordre de la liste)",

    drop_title: "Déposez vos fichiers MP3 / audio ici",
    drop_sub_default: "Affectation à la catégorie sélectionnée",
    drop_sub_fallback: "Affecté à la catégorie par défaut : {icon} {name}",
    drop_sub_assigned: "Sera affecté à : {icon} {name}",
    drop_err_no_audio: "⚠️ Aucun fichier audio détecté (veuillez déposer des fichiers MP3, WAV, M4A, OGG ou FLAC).",
    drop_uploading_one: "⏳ Importation d'1 titre dans « {icon} {name} » & analyse de l'onde...",
    drop_uploading_many: "⏳ Importation de {count} titres dans « {icon} {name} » & analyse de l'onde...",
    drop_done_one: "✅ 1 titre ajouté dans « {icon} {name} » !",
    drop_done_many: "✅ {count} titres ajoutés dans « {icon} {name} » !",
    drop_err_upload: "⚠️ Erreur lors de l'importation : {err}",

    empty_tracks_title: "Aucun titre trouvé dans cette vue",
    empty_tracks_sub: "Glissez-déposez simplement des fichiers MP3 ici ou utilisez le bouton d'import en haut à droite.",
    track_drag_title: "Maintenir et glisser pour réorganiser",
    play_from_start_title: "Lancer le titre depuis le début (0:00)",
    default_artist: "Titre de compétition",
    cue_btn_tip: "{num} : {label} (dès {time})",
    loop_active_title: "Boucle infinie active (Marche/Arrêt)",
    loop_inactive_title: "Activer la boucle infinie (Marche/Arrêt)",
    loop_aria: "Boucle infinie",
    edit_cues_title: "Modifier les moments forts et la forme d'onde",
    edit_waveform_title: "Ouvrir les moments forts et la forme d'onde",

    // Master Fader & Talkover
    master_vol_title: "VOLUME PRINCIPAL",
    master_vol_aria: "Volume principal",
    eff_talkover: "🎤 Annonce active – atténué ({pct}%)",
    eff_fading_out: "📉 Fondu de sortie en cours... ({pct}%)",
    eff_crossfading: "🔀 Fondu enchaîné vers le titre suivant ({pct}%)",
    eff_output: "Niveau de sortie : {pct}%",
    srv_eff_talkover: "🎤 Annonce serveur active ({pct}%)",
    srv_eff_fading_out: "📉 Fondu serveur en cours... ({pct}%)",
    srv_eff_crossfading: "🔀 Fondu enchaîné serveur ({pct}%)",
    srv_eff_output: "🔊 Niveau serveur : {pct}%",
    badge_on: "ACTIF",
    badge_off: "ARRÊT",
    talkover_title: "ANNONCE / TALKOVER",
    talkover_desc: "Baisser doucement la musique à {pct}%",
    autofade_label: "Fondu auto",
    autonext_label: "Titre suivant automatique",
    shuffle_label: "🔀 Lecture aléatoire (Shuffle)",
    crossfade_label: "Fondu enchaîné",

    // Now Playing Deck & Mobile Dock
    deck_ready: "Prêt pour le prochain lancement",
    deck_paused: "En pause / Prêt",
    deck_playing: "Diffusé en direct dans la salle",
    deck_fading: "Fondu de sortie en cours...",
    deck_crossfading: "🔀 Fondu enchaîné vers le titre suivant...",
    np_loop_title: "Répéter le titre actuel en boucle infinie",
    np_loop_on: "🔁 Boucle : OUI",
    np_loop_off: "🔁 Boucle : NON",
    np_no_track: "Aucun titre chargé",
    np_tap_hint: "Appuyez sur un titre ou un numéro pour démarrer",
    np_active_cue: "Moment fort actif : {label} ({time})",
    np_from_start: "Depuis le début",
    np_from_start_cue: "▶ Depuis le début",
    np_next_loop: "🔁 Boucle infinie active (répète ce titre)",
    np_next_xfade: "🔀 Fondu enchaîné",
    np_next_after: "⏭ À suivre",
    np_next_shuffle: "🔀 Aléatoire",
    np_next_shuffle_xfade: "🔀 Aléatoire (Fondu)",
    np_next_stop: "⏹ S'arrête à la fin du titre",
    skip_next_btn: "⏭ Suivant",
    skip_next_title: "Passer immédiatement au titre suivant",
    np_waveform_title: "Appuyer pour naviguer dans le titre",
    play_start: "LIRE",
    play_pause: "PAUSE",
    play_resume: "REPRENDRE",
    fade_out_btn: "FONDU DE SORTIE",
    fade_out_sub: "Fondu {sec}s",
    stop_immediate_btn: "ARRÊT IMMÉDIAT",

    mob_mode_server: "🔊 Serveur",
    mob_mode_local: "📱 Appareil",
    mob_paused: "En pause",
    mob_ready_server: "🔊 Serveur prêt",
    mob_ready_local: "📱 Appareil prêt",
    mob_play_title: "Lecture / Pause",
    mob_fade_title: "Fondu de sortie",
    mob_talk_title: "Annonce / Talkover",
    mob_tab_songs: "🎵 Titres",
    mob_tab_fader_prefix: "🎚️ Fader",
    mob_tab_deck: "💿 En cours",

    // Editor Modal
    editor_title_default: "Modifier les moments forts & l'onde",
    editor_title_prefix: "✂️ Moments forts & onde : {title}",
    editor_subtitle: "Cliquez dans la forme d'onde pour préécouter et enregistrer vos repères de départ pour la compétition.",
    meta_title_label: "Titre du morceau",
    meta_title_ph: "Titre",
    meta_artist_label: "Artiste / Note",
    meta_artist_ph: "Artiste / Indication",
    meta_cat_label: "Catégorie",
    meta_vol_label: "Volume du titre",
    meta_loop_label: "Boucle infinie",
    meta_loop_no: "Non",
    meta_loop_yes: "Oui (Boucle)",
    meta_save_btn: "💾 Enregistrer",
    editor_preview_play: "▶ Préécouter ici",
    editor_preview_stop: "⏸ Arrêter l'écoute",
    editor_back_title: "Reculer de 2 secondes",
    editor_fwd_title: "Avancer de 2 secondes",
    editor_pos_label: "Position :",
    editor_mark_btn: "📍 Enregistrer la position actuelle comme moment fort",
    editor_cues_heading: "Moments forts enregistrés (boutons d'accès rapide)",
    editor_no_cues: "Aucun moment fort enregistré. Appuyez sur « 📍 Enregistrer la position actuelle comme moment fort » ci-dessus.",
    cue_color_title: "Couleur du bouton {num}",
    cue_btn_label_prefix: "Bouton",
    cue_btn_label_suffix: "– Note / Libellé",
    cue_label_ph: "ex. Refrain / Drop",
    cue_start_label: "Début (secondes)",
    cue_use_cursor_title: "Reprendre la position actuelle du curseur",
    cue_end_label: "Fin optionnelle (sec.)",
    cue_end_ph: "Jusqu'à la fin",
    cue_fade_title: "Fondu d'entrée doux ou démarrage immédiat à 100%",
    cue_fade_label: "Fondu d'entrée",
    cue_test_btn: "▶ Tester",
    cue_test_title: "Préécouter depuis ce moment fort",
    cue_del_title: "Supprimer ce moment fort",
    delete_track_btn: "🗑️ Supprimer définitivement le titre",
    done_editor_btn: "Terminer & Fermer",
    confirm_delete_track: "Voulez-vous vraiment supprimer définitivement « {title} » ?",
    unnamed_track: "Sans titre",

    // Upload Modal
    upload_modal_title: "➕ Ajouter des fichiers MP3 / Audio",
    upload_modal_sub: "Les titres importés sont sauvegardés durablement sur le serveur pour toutes vos compétitions.",
    dropzone_title: "Déposez vos fichiers MP3 ici ou appuyez pour sélectionner",
    dropzone_sub_default: "Sélection multiple possible (MP3, WAV, M4A, OGG)",
    dropzone_files_selected: "{count} fichier(s) sélectionné(s) : {names}",
    upload_cat_label: "Catégorie à attribuer",
    upload_color_label: "Couleur par défaut",
    upload_progress_text: "Importation des titres et analyse de la forme d'onde...",
    cancel_btn: "Annuler",
    submit_upload_btn: "⬆️ Importer & enregistrer",
    err_upload_alert: "Erreur d'importation : {err}",

    // Settings Modal
    settings_title: "⚙️ Paramètres",
    settings_subtitle: "Design, langue, accès Wi-Fi (QR / PIN), durées de fondu, catégories et mise à jour GitHub.",
    theme_heading: "🎛️ Apparence / Design",
    theme_sub: "Choisissez entre un look studio professionnel sobre et le design coloré de compétition :",
    theme_studio_btn: "🎛️ Studio Pro (Sobre)",
    theme_arena_btn: "🏟️ Arena Classique (Coloré)",
    lang_heading: "🌐 Langue",
    lang_sub: "Afficher immédiatement tous les textes et libellés dans la langue choisie :",

    sec_header: "🔒 Accès Wi-Fi protégé (iPad / Mobile)",
    sec_protected: "🔒 PROTÉGÉ",
    sec_open: "🔓 OUVERT",
    qr_alt: "QR code d'accès direct pour iPad",
    qr_caption: "📱 Scanner avec l'iPad",
    sec_way1_label: "1. Scanner le QR code ou utiliser le lien direct secret (avec jeton) :",
    copy_btn: "📋 Copier",
    rotate_btn: "🔄 Nouveau",
    rotate_title: "Génère immédiatement un nouveau lien + QR code et révoque l'ancien",
    lan_hint: "Scannez simplement avec l'appareil photo de l'iPad/téléphone → connecté immédiatement pour 30 jours sans saisir de mot de passe !",
    sec_way2_label: "2. Ou ouvrir l'adresse Wi-Fi courte & saisir le mot de passe / code PIN :",
    address_label: "Adresse :",
    pin_initial: "Code PIN initial actuel : {pin}",
    pin_custom: "✅ Mot de passe / PIN personnalisé actif",
    new_pw_ph: "Nouveau mot de passe / PIN (min. 4 caractères)",
    save_pw_btn: "🔑 Définir le mot de passe",
    sec_auth_enabled_label: "Activer la protection Wi-Fi (accès impossible sans jeton ou mot de passe)",
    sec_auth_localhost_label: "Exiger aussi le mot de passe directement sur ce PC serveur (localhost)",
    fb_copied: "✅ Lien direct secret copié dans le presse-papiers !",
    confirm_rotate_token: "Générer un nouveau lien secret ? L'ancien lien deviendra immédiatement invalide et les autres appareils seront déconnectés.",
    fb_rotated: "🔄 Nouveau lien secret généré ! Les anciens liens sont bloqués.",
    fb_pw_short: "⚠️ Veuillez saisir au moins 4 caractères pour le mot de passe / PIN.",
    fb_pw_saved: "✅ Nouveau mot de passe / PIN enregistré !",
    fb_pw_err: "Erreur lors de l'enregistrement.",

    set_fade_in_label: "Fondu d'entrée au démarrage (sec.)",
    set_fade_out_label: "Fondu de sortie à l'arrêt (sec.)",
    set_xfade_label: "Fondu enchaîné / Crossfade (sec.)",
    set_duck_vol_label: "Volume pendant annonce / Talkover (%)",
    set_duck_fade_label: "Durée de transition Talkover (secondes)",

    manage_cats_heading: "Gérer les catégories",
    del_cat_title: "Supprimer la catégorie",
    new_cat_ph: "Nouvelle catégorie (ex. Demi-finale)",
    add_cat_btn: "+ Ajouter",

    update_heading: "🔄 Mise à jour logicielle (GitHub)",
    version_local_badge: "Version locale",
    version_commit_badge: "Commit {short}",
    version_details_git: "Version installée : {short} ({date}) – « {subject} ». Vos titres et la base de données restent intacts.",
    version_details_fallback: "Vérifiez si une nouvelle version est disponible sur GitHub. Vos titres, moments forts et réglages sont intégralement conservés.",
    check_update_btn: "🔍 Vérifier les mises à jour",
    checking_update_btn: "⏳ Vérification sur GitHub...",
    install_update_btn: "⬇️ Mettre à jour maintenant",
    installing_update_btn: "⏳ Mise à jour en cours...",
    update_checking_msg: "Connexion à GitHub et recherche d'une nouvelle version...",
    update_available_one: "🚀 Nouvelle version disponible sur GitHub ! (1 modification – dernière : {short})",
    update_available_many: "🚀 Nouvelle version disponible sur GitHub ! ({count} modifications – dernière : {short})",
    update_up_to_date_msg: "✅ Vous utilisez déjà la dernière version ({short}).",
    update_check_failed: "Échec de la vérification des mises à jour.",
    update_conn_err: "⚠️ Erreur de connexion au serveur : {err}",
    confirm_update_playing: "Remarque : de la musique est en cours de lecture. Si des fichiers serveur sont mis à jour, le serveur redémarrera brièvement (~1–2 sec). Mettre à jour maintenant ?",
    update_downloading_msg: "⏳ Téléchargement depuis GitHub et installation de la mise à jour...",
    update_install_failed: "La mise à jour n'a pas pu être installée.",
    update_restarting_msg: "✅ Mis à jour vers {short} ! Redémarrage rapide du serveur – rechargement automatique...",
    update_done_reload_msg: "✅ Mise à jour installée ({short}) ! Rechargement de l'interface...",
    update_fast_restart_msg: "🔄 Redémarrage du serveur – l'interface va se recharger automatiquement...",

    backup_btn: "📦 Télécharger une sauvegarde (réglages & moments forts)",
    logout_btn: "🔒 Déconnecter l'appareil",
    logout_title: "Déconnecter et verrouiller cet appareil",
    save_settings_btn: "💾 Enregistrer les paramètres",
    beforeunload_msg: "La musique est diffusée en direct (ON AIR) !",
  },
};

const SUPPORTED_THEMES = ["studio", "arena"];

let currentLang = localStorage.getItem("arena_dj_lang") || "de";
if (!SUPPORTED_LANGUAGES.includes(currentLang)) {
  currentLang = "de";
}

let currentTheme = localStorage.getItem("arena_dj_theme") || "studio";
if (!SUPPORTED_THEMES.includes(currentTheme)) {
  currentTheme = "studio";
}

function getLang() {
  return currentLang;
}

function setLangCode(lang) {
  if (SUPPORTED_LANGUAGES.includes(lang)) {
    currentLang = lang;
    localStorage.setItem("arena_dj_lang", lang);
  }
  return currentLang;
}

function getTheme() {
  return currentTheme;
}

function setThemeCode(theme) {
  if (SUPPORTED_THEMES.includes(theme)) {
    currentTheme = theme;
    localStorage.setItem("arena_dj_theme", theme);
  }
  if (document.body) {
    document.body.dataset.theme = currentTheme;
  }
  return currentTheme;
}

const STUDIO_EMOJI_STRIP_RE =
  /^(?:[\u{1F300}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]\uFE0F?\s*)+/gu;

function t(key, vars = {}) {
  const pack = TRANSLATIONS[currentLang] || TRANSLATIONS.de;
  let str = pack[key] ?? TRANSLATIONS.de[key] ?? key;
  for (const [k, v] of Object.entries(vars)) {
    str = str.replaceAll(`{${k}}`, String(v));
  }
  if (
    currentTheme === "studio" &&
    key !== "theme_studio_btn" &&
    key !== "theme_arena_btn"
  ) {
    str = str.replace(STUDIO_EMOJI_STRIP_RE, "").trim();
  }
  return str;
}

function getCategoryDisplayName(cat) {
  if (!cat) return "";
  const mapEntry = DEFAULT_CATEGORY_TRANSLATIONS[cat.id];
  if (mapEntry) {
    // Nur übersetzen, wenn der Nutzer den ursprünglichen Standardnamen beibehalten hat
    const allDefaultNames = Object.values(mapEntry);
    if (allDefaultNames.includes(cat.name)) {
      return mapEntry[currentLang] || cat.name;
    }
  }
  return cat.name;
}

function applyStaticTranslations() {
  document.documentElement.lang = currentLang;
  document.title = t("page_title");

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPlaceholder);
  });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t(el.dataset.i18nTitle);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  });
  document.querySelectorAll("[data-i18n-alt]").forEach((el) => {
    el.alt = t(el.dataset.i18nAlt);
  });
}
