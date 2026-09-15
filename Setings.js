// ════════════════════════════════════════
//  Setings.js  —  KAIROS SETTINGS  v2
//
//  NEW IN v2:
//  1. Orb State Animations  (standby / listening / responding / thinking / error)
//  2. Signal Strength Indicator  (good / fair / bad / offline)
//  3. Orb & Ring Customization  (color pickers in settings panel)
//  4. Fixed SET button wiring  (no double-bind conflict)
//
//  EXISTING:
//  • Theme Switcher (Cyan, Amber, Green, Purple, Red)
//  • Voice Picker + Speed + Pitch
//  • Keyboard shortcut G
//  • Voice commands
// ════════════════════════════════════════

(function () {

  const STORAGE_KEY = 'kairos_settings';
  let panelOpen = false;

  // ── DEFAULTS ──
  // Orb colours default to the brand cyan stop (#5BD8E0). buildGradient()
  // anchors every orb on the brand indigo (#6E8CFF) and uses the state
  // colour as the outer tone, so the out-of-the-box orb is exactly the
  // indigo→cyan brand gradient in every normal state. The colour pickers
  // remain fully functional (a user can still tint each state). Error keeps
  // a distinct, on-palette warning tone for semantic feedback.
  const DEFAULTS = {
    theme:           'cyan',
    voiceName:       '',
    voiceRate:       1.05,
    voicePitch:      0.85,
    orbStandbyColor: '#5BD8E0',
    orbListenColor:  '#5BD8E0',
    orbThinkColor:   '#5BD8E0',
    orbSpeakColor:   '#5BD8E0',
    orbErrorColor:   '#E86A6A',
    ringColor:       '#5BD8E0',
  };

  // ── THEMES ──
  const THEMES = {
    cyan:   { label: 'CYAN',   primary: '#5BD8E0', dim: 'rgba(91,216,224,0.35)',  glow: 'rgba(91,216,224,0.9)'  },
    amber:  { label: 'AMBER',  primary: '#ffb300', dim: 'rgba(255,179,0,0.35)',   glow: 'rgba(255,179,0,0.9)'   },
    green:  { label: 'GREEN',  primary: '#00ff8c', dim: 'rgba(0,255,140,0.35)',   glow: 'rgba(0,255,140,0.9)'   },
    purple: { label: 'PURPLE', primary: '#c084fc', dim: 'rgba(192,132,252,0.35)', glow: 'rgba(192,132,252,0.9)' },
    red:    { label: 'RED',    primary: '#ff4444', dim: 'rgba(255,68,68,0.35)',   glow: 'rgba(255,68,68,0.9)'   },
  };

  // ── LOAD SETTINGS ──
  let settings = { ...DEFAULTS };
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    settings = { ...DEFAULTS, ...saved };
  } catch (e) {}

  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (e) {}
  }

  // ════════════════════════════════════════
  //  THEME ENGINE
  // ════════════════════════════════════════
  function applyTheme(themeName) {
    const theme = THEMES[themeName] || THEMES.cyan;
    settings.theme = themeName;
    saveSettings();

    const root = document.documentElement;
    root.style.setProperty('--cyan',     theme.primary);
    root.style.setProperty('--cyan-dim', theme.dim);

    applyOrbState(currentOrbState);

    document.querySelectorAll('.theme-btn').forEach(btn => {
      const active = btn.dataset.theme === themeName;
      btn.style.borderColor = active ? theme.primary : 'rgba(255,255,255,0.1)';
      btn.style.transform   = active ? 'scale(1.12)' : 'scale(1)';
      btn.style.boxShadow   = active ? `0 0 12px ${theme.glow}` : 'transparent';
    });

    const lbl = document.getElementById('theme-label');
    if (lbl) lbl.textContent = `CURRENT: ${theme.label}`;
  }

  // ════════════════════════════════════════
  //  ORB ANIMATION ENGINE
  // ════════════════════════════════════════
  let currentOrbState = 'standby';
  let orbAnimFrame = null;

  // Inject orb keyframe animations once
  function injectOrbStyles() {
    if (document.getElementById('kairos-orb-styles')) return;
    const style = document.createElement('style');
    style.id = 'kairos-orb-styles';
    style.textContent = `
      @keyframes orb-standby {
        0%,100% { transform: scale(1);    filter: brightness(1);   }
        50%      { transform: scale(1.04); filter: brightness(1.15); }
      }
      @keyframes orb-listening {
        0%,100% { transform: scale(1);    filter: brightness(1);   }
        25%     { transform: scale(1.07); filter: brightness(1.3);  }
        75%     { transform: scale(0.97); filter: brightness(0.9);  }
      }
      @keyframes orb-thinking {
        0%   { transform: scale(1)    rotate(0deg);   filter: brightness(1);   }
        33%  { transform: scale(1.05) rotate(1deg);   filter: brightness(1.2); }
        66%  { transform: scale(1.02) rotate(-1deg);  filter: brightness(1.1); }
        100% { transform: scale(1)    rotate(0deg);   filter: brightness(1);   }
      }
      @keyframes orb-speaking {
        0%,100% { transform: scale(1);    filter: brightness(1);   }
        20%     { transform: scale(1.06); filter: brightness(1.25); }
        40%     { transform: scale(1.02); filter: brightness(1.05); }
        60%     { transform: scale(1.08); filter: brightness(1.3);  }
        80%     { transform: scale(1.01); filter: brightness(1.08); }
      }
      @keyframes orb-error {
        0%,100% { transform: scale(1)    translateX(0);   }
        20%     { transform: scale(1.03) translateX(-3px); }
        40%     { transform: scale(1.03) translateX(3px);  }
        60%     { transform: scale(1.03) translateX(-2px); }
        80%     { transform: scale(1.03) translateX(2px);  }
      }
      /* Ring color override via CSS var */
      .r2 { border-top-color: var(--ring-color, var(--cyan)) !important; }
    `;
    document.head.appendChild(style);
  }

  // Convert hex to rgb parts for glow construction
  function hexToRgb(hex) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    return `${r},${g},${b}`;
  }

  function buildGradient(hex) {
    const rgb = hexToRgb(hex);
    // Brand indigo core (#6E8CFF) → the picked/state colour as the outer tone
    // → dark rim, under a soft specular highlight. With the default colours
    // this renders exactly the #6E8CFF→#5BD8E0 brand gradient; picking another
    // colour re-tints the outer tone, so the picker stays meaningful.
    return `radial-gradient(circle at 36% 30%,
      rgba(255,255,255,0.55) 0%,
      rgba(110,140,255,0.95) 27%,
      rgba(${rgb},0.92) 63%,
      rgba(8,12,26,0.96) 100%)`;
  }

  function buildGlow(hex, state) {
    const rgb = hexToRgb(hex);
    const intensities = {
      standby:   [0.9,  0.45, 0.2 ],
      listening: [1.0,  0.6,  0.3 ],
      thinking:  [1.0,  0.55, 0.25],
      speaking:  [0.95, 0.55, 0.28],
      error:     [1.0,  0.5,  0.2 ],
    };
    const [a,b,c] = intensities[state] || intensities.standby;
    return `0 0 40px rgba(${rgb},${a}), 0 0 80px rgba(${rgb},${b}), 0 0 130px rgba(${rgb},${c}), inset 0 0 35px rgba(${rgb},0.12)`;
  }

  const STATE_ANIMATIONS = {
    standby:  'orb-standby  3s   ease-in-out infinite',
    listening:'orb-listening 0.6s ease-in-out infinite',
    thinking: 'orb-thinking  1.2s ease-in-out infinite',
    speaking: 'orb-speaking  0.9s ease-in-out infinite',
    error:    'orb-error     0.5s ease-in-out infinite',
  };

  const STATE_COLOR_KEY = {
    standby:  'orbStandbyColor',
    listening:'orbListenColor',
    thinking: 'orbThinkColor',
    speaking: 'orbSpeakColor',
    error:    'orbErrorColor',
  };

  function applyOrbState(state) {
    currentOrbState = state;
    const orb = document.getElementById('orb');
    if (!orb) return;

    const hex = settings[STATE_COLOR_KEY[state]] || DEFAULTS[STATE_COLOR_KEY[state]] || '#00d4ff';

    // Remove old state classes
    orb.classList.remove('orb-standby','orb-listening','orb-thinking','orb-speaking','orb-error','listening');
    orb.classList.add(`orb-${state}`);

    // Apply gradient + glow + animation
    orb.style.background  = buildGradient(hex);
    orb.style.boxShadow   = buildGlow(hex, state);
    orb.style.animation   = STATE_ANIMATIONS[state] || STATE_ANIMATIONS.standby;
    orb.style.transition  = 'background 0.45s ease, box-shadow 0.45s ease';
  }

  window.setOrbState = applyOrbState;

  // ════════════════════════════════════════
  //  RING COLOR ENGINE
  // ════════════════════════════════════════
  function applyRingColor(hex) {
    settings.ringColor = hex;
    saveSettings();
    document.documentElement.style.setProperty('--ring-color', hex);
    const preview = document.getElementById('ring-color-preview');
    if (preview) preview.style.background = hex;
  }

  // ════════════════════════════════════════
  //  SIGNAL STRENGTH ENGINE
  // ════════════════════════════════════════
  let signalInterval = null;

  function getSignalQuality() {
    if (!navigator.onLine) return { label: 'OFFLINE', color: '#ff4444', bars: 0 };
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (!conn) return { label: 'NET: GOOD', color: '#00ff8c', bars: 3 };

    const rtt  = conn.rtt  || 0;
    const dl   = conn.downlink || 10;

    if (rtt < 150 && dl >= 2)  return { label: 'NET: GOOD', color: '#00ff8c', bars: 3 };
    if (rtt < 400 && dl >= 0.5) return { label: 'NET: FAIR', color: '#ffb300', bars: 2 };
    return                               { label: 'NET: WEAK', color: '#ff4444', bars: 1 };
  }

  function renderSignalBars(bars, color) {
    const heights = [6, 10, 14];
    return heights.map((h, i) => {
      const active = i < bars;
      return `<span style="display:inline-block;width:3px;height:${h}px;
        border-radius:1px;margin-right:2px;vertical-align:bottom;
        background:${active ? color : 'rgba(255,255,255,0.12)'};
        box-shadow:${active ? `0 0 4px ${color}` : 'none'};
        transition:background 0.4s,box-shadow 0.4s;"></span>`;
    }).join('');
  }

  function updateSignalDisplay() {
    const sig = getSignalQuality();

    // Update bottom strip NET span
    const strip = document.getElementById('strip');
    if (strip) {
      let netSpan = document.getElementById('signal-span');
      if (!netSpan) {
        // Replace the static "NET: ACTIVE" span
        strip.querySelectorAll('span').forEach(s => {
          if (s.textContent.includes('NET:')) { s.id = 'signal-span'; netSpan = s; }
        });
      }
      if (netSpan) {
        netSpan.style.color = sig.color;
        netSpan.style.textShadow = `0 0 8px ${sig.color}`;
        netSpan.innerHTML = `${renderSignalBars(sig.bars, sig.color)} ${sig.label}`;
      }
    }

    // Update settings panel signal display
    const panelSig = document.getElementById('settings-signal-label');
    const panelBars = document.getElementById('settings-signal-bars');
    if (panelSig) { panelSig.textContent = sig.label; panelSig.style.color = sig.color; }
    if (panelBars) panelBars.innerHTML = renderSignalBars(sig.bars, sig.color);
  }

  function startSignalMonitor() {
    if (signalInterval) return;
    updateSignalDisplay();
    signalInterval = setInterval(updateSignalDisplay, 3000);
    window.addEventListener('online',  updateSignalDisplay);
    window.addEventListener('offline', updateSignalDisplay);
    if (navigator.connection) {
      navigator.connection.addEventListener('change', updateSignalDisplay);
    }
  }

  // ════════════════════════════════════════
  //  VOICE ENGINE
  // ════════════════════════════════════════
  let availableVoices = [];

  function loadVoiceList() {
    availableVoices = window.speechSynthesis.getVoices();
    renderVoiceSelect();
  }

  window.speechSynthesis.onvoiceschanged = loadVoiceList;
  loadVoiceList();

  function getSelectedVoice() {
    if (settings.voiceName) {
      const found = availableVoices.find(v => v.name === settings.voiceName);
      if (found) return found;
    }
    const preferred = [
      'Google UK English Male',
      'Microsoft Ryan Online (Natural) - English (United Kingdom)',
      'Microsoft Guy Online (Natural) - English (United States)',
      'Daniel', 'Arthur', 'Google US English', 'Alex'
    ];
    for (const name of preferred) {
      const found = availableVoices.find(v => v.name.includes(name));
      if (found) return found;
    }
    return availableVoices.find(v => /en/i.test(v.lang)) || null;
  }

  function patchSpeak() {
    if (!window.speak || window.speak._settingsPatched) return;
    const originalSpeak = window.speak;
    window.speak = function(text, onDone) {
      if (!('speechSynthesis' in window)) { if (onDone) onDone(); return; }
      window.speechSynthesis.cancel();
      let doneFired = false;
      function fireDone() { if (doneFired) return; doneFired = true; if (onDone) onDone(); }
      const u = new SpeechSynthesisUtterance(text);
      u.rate   = settings.voiceRate;
      u.pitch  = settings.voicePitch;
      u.volume = 1;
      const voice = getSelectedVoice();
      if (voice) u.voice = voice;
      u.onend = fireDone; u.onerror = fireDone;
      setTimeout(fireDone, 8000);
      window.speechSynthesis.speak(u);
    };
    window.speak._settingsPatched = true;
  }

  function tryPatchSpeak() {
    if (window.speak) patchSpeak();
    else setTimeout(tryPatchSpeak, 300);
  }
  tryPatchSpeak();

  // ════════════════════════════════════════
  //  VOICE COMMAND HANDLER
  // ════════════════════════════════════════
  function handleVoice(text) {
    const lower = text.toLowerCase();
    if (['open settings','show settings','settings','change settings',
         'open preferences','show preferences'].some(p => lower.includes(p))) {
      togglePanel(); return "Opening settings panel.";
    }
    for (const [key, theme] of Object.entries(THEMES)) {
      if (lower.includes(`${key} theme`) || lower.includes(`switch to ${key}`) ||
          lower.includes(`change to ${key}`) || lower.includes(`theme ${key}`)) {
        applyTheme(key); return `Switched to ${theme.label} theme.`;
      }
    }
    if (['speak faster','talk faster','speed up','faster'].some(p => lower.includes(p))) {
      settings.voiceRate = Math.min(2.0, settings.voiceRate + 0.15);
      saveSettings(); updateSpeedDisplay(); return `Speaking faster now.`;
    }
    if (['speak slower','talk slower','slow down','slower'].some(p => lower.includes(p))) {
      settings.voiceRate = Math.max(0.5, settings.voiceRate - 0.15);
      saveSettings(); updateSpeedDisplay(); return `Speaking slower now.`;
    }
    if (['higher pitch','raise your voice','higher voice'].some(p => lower.includes(p))) {
      settings.voicePitch = Math.min(2.0, settings.voicePitch + 0.15);
      saveSettings(); updatePitchDisplay(); return `Pitch raised.`;
    }
    if (['lower pitch','lower your voice','deeper voice','lower voice'].some(p => lower.includes(p))) {
      settings.voicePitch = Math.max(0.1, settings.voicePitch - 0.15);
      saveSettings(); updatePitchDisplay(); return `Pitch lowered.`;
    }
    if (['reset voice','default voice','reset settings'].some(p => lower.includes(p))) {
      settings.voiceRate  = DEFAULTS.voiceRate;
      settings.voicePitch = DEFAULTS.voicePitch;
      settings.voiceName  = DEFAULTS.voiceName;
      saveSettings(); updateSpeedDisplay(); updatePitchDisplay(); return `Voice reset to default.`;
    }
    return null;
  }

  // ════════════════════════════════════════
  //  SETTINGS PANEL UI
  // ════════════════════════════════════════
  function ensurePanel() {
    // RETIRED: settings now live on the dedicated /settings page (settings.htm),
    // which togglePanel() opens. The old inline bottom-sheet panel was already
    // disabled by an early `return` and had no live callers — its
    // window.kairosSettings.* inline handlers only ever existed inside that dead
    // markup, while the real controls (theme / voice / orb / signal) are wired in
    // settings.htm. The ~230 lines of unreachable panel markup have been removed;
    // this stays a safe no-op that clears a stale panel node if one is present.
    document.getElementById('settings-panel')?.remove();
  }

  // ── VOICE SELECT RENDER ──
  function renderVoiceSelect() {
    const sel = document.getElementById('voice-select');
    if (!sel) return;
    availableVoices = window.speechSynthesis.getVoices();
    sel.innerHTML = '<option value="">Auto (Recommended)</option>';
    availableVoices
      .filter(v => v.lang.startsWith('en') || v.localService)
      .forEach(v => {
        const opt = document.createElement('option');
        opt.value = v.name;
        opt.textContent = `${v.name} (${v.lang})`;
        opt.selected = v.name === settings.voiceName;
        sel.appendChild(opt);
      });
  }

  // ── DISPLAY UPDATES ──
  function updateSpeedDisplay() {
    const el = document.getElementById('speed-val');
    const sl = document.getElementById('speed-slider');
    if (el) el.textContent = `${settings.voiceRate.toFixed(2)}x`;
    if (sl) sl.value = settings.voiceRate;
  }

  function updatePitchDisplay() {
    const el = document.getElementById('pitch-val');
    const sl = document.getElementById('pitch-slider');
    if (el) el.textContent = settings.voicePitch.toFixed(2);
    if (sl) sl.value = settings.voicePitch;
  }

  // ════════════════════════════════════════
  //  TOGGLE PANEL
  // ════════════════════════════════════════
  function togglePanel() {
    if (typeof window.openKairosSettings === 'function') window.openKairosSettings();
    else window.location.href = '/settings';
  }

  // ════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════
  window.kairosSettings = {
    togglePanel,
    handleVoice,
    applyTheme,
    setOrbState: applyOrbState,

    previewOrbState(state) {
      applyOrbState(state);
      // Revert to standby after 2s
      clearTimeout(window._orbPreviewTimer);
      window._orbPreviewTimer = setTimeout(() => applyOrbState('standby'), 2000);
    },

    setOrbColor(state, key, hex) {
      settings[key] = hex;
      saveSettings();
      // Update mini preview dot
      const dot = document.getElementById(`orb-preview-${state}`);
      if (dot) { dot.style.background = hex; dot.style.boxShadow = `0 0 8px ${hex}`; }
      // If we're previewing this state, update live
      if (currentOrbState === state) applyOrbState(state);
    },

    setRingColor(hex) {
      applyRingColor(hex);
    },

    setVoice(name) {
      settings.voiceName = name;
      saveSettings();
    },

    testVoice() {
      const v = getSelectedVoice();
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance("Systems online. How may I assist you today?");
      u.rate = settings.voiceRate; u.pitch = settings.voicePitch; u.volume = 1;
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    },

    adjustSpeed(delta) {
      settings.voiceRate = Math.min(2.0, Math.max(0.5, settings.voiceRate + delta));
      saveSettings(); updateSpeedDisplay();
    },

    setSpeed(val) {
      settings.voiceRate = val;
      saveSettings(); updateSpeedDisplay();
    },

    adjustPitch(delta) {
      settings.voicePitch = Math.min(2.0, Math.max(0.1, settings.voicePitch + delta));
      saveSettings(); updatePitchDisplay();
    },

    setPitch(val) {
      settings.voicePitch = val;
      saveSettings(); updatePitchDisplay();
    },

    resetAll() {
      settings = { ...DEFAULTS };
      saveSettings();
      applyTheme('cyan');
      applyRingColor(DEFAULTS.ringColor);
      updateSpeedDisplay();
      updatePitchDisplay();
      renderVoiceSelect();
      // Reset orb previews in panel
      Object.entries({
        standby:'orbStandbyColor', listening:'orbListenColor',
        thinking:'orbThinkColor',  speaking:'orbSpeakColor', error:'orbErrorColor'
      }).forEach(([state, key]) => {
        const dot = document.getElementById(`orb-preview-${state}`);
        if (dot) { dot.style.background = DEFAULTS[key]; dot.style.boxShadow = `0 0 8px ${DEFAULTS[key]}`; }
      });
      applyOrbState('standby');
      if (typeof window.speak === 'function') window.speak("Settings reset to default.");
    },

    getRate()  { return settings.voiceRate;  },
    getPitch() { return settings.voicePitch; },
    getVoice() { return getSelectedVoice();  },
  };

  // ════════════════════════════════════════
  //  KEYBOARD SHORTCUT  G
  // ════════════════════════════════════════
  // NOTE: no keyboard shortcut bound here anymore — script.js's global
  // keydown handler already sends "G" to /settings (settings.htm), and
  // having both handlers fire on the same key caused the same conflict
  // the SET button had (panel opens, then the page immediately navigates
  // away and closes it again).

  // ── SET BUTTON — intentionally NOT wired here anymore.
  // index.htm's own listener sends it to /settings (settings.htm), which now
  // has the full voice/theme/orb controls. Wiring it here too caused both a
  // navigation AND a panel-open on the same click, so the panel was never
  // actually visible before the page navigated away.
  function wireSettingsBtn() { /* no-op — kept as a stub so calls below don't error */ }

  // ════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════
  function init() {
    injectOrbStyles();
    applyTheme(settings.theme);
    applyRingColor(settings.ringColor);
    document.getElementById('settings-panel')?.remove();

    // Wire button — try now and after DOM ready
    wireSettingsBtn();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireSettingsBtn);
    }

    // Apply orb standby state once interface is visible
    const tryOrb = () => {
      if (document.getElementById('orb')) {
        applyOrbState('standby');
      } else {
        setTimeout(tryOrb, 300);
      }
    };
    tryOrb();

    // Start signal monitor
    startSignalMonitor();

    setTimeout(tryPatchSpeak, 800);
  }

  init();

})();
