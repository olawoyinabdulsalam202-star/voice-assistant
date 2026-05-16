// ════════════════════════════════════════
//  settings.js  —  KAIROS SETTINGS
//  v1
//
//  FEATURES:
//  1. Theme Switcher (Cyan, Amber, Green, Purple, Red)
//  2. Orb Emotions (color per state)
//  3. Voice Picker (all available device voices)
//  4. Voice Speed & Pitch Control
//
//  HOW TO OPEN:
//  • Click  ⚙ SET  button in right HUD
//  • Press  G  on keyboard
//  • Say "open settings" / "change theme" /
//        "speak faster" / "change voice"
//
//  All preferences saved to localStorage
// ════════════════════════════════════════

(function () {

  const STORAGE_KEY = 'kairos_settings';
  let panelOpen = false;

  // ── DEFAULTS ──
  const DEFAULTS = {
    theme:      'cyan',
    voiceName:  '',       // empty = auto-select best
    voiceRate:  1.05,
    voicePitch: 0.85,
  };

  // ── THEMES ──
  const THEMES = {
    cyan:   { label: 'CYAN',   primary: '#00d4ff', dim: 'rgba(0,212,255,0.35)',  glow: 'rgba(0,212,255,0.9)'  },
    amber:  { label: 'AMBER',  primary: '#ffb300', dim: 'rgba(255,179,0,0.35)',  glow: 'rgba(255,179,0,0.9)'  },
    green:  { label: 'GREEN',  primary: '#00ff8c', dim: 'rgba(0,255,140,0.35)',  glow: 'rgba(0,255,140,0.9)'  },
    purple: { label: 'PURPLE', primary: '#c084fc', dim: 'rgba(192,132,252,0.35)', glow: 'rgba(192,132,252,0.9)' },
    red:    { label: 'RED',    primary: '#ff4444', dim: 'rgba(255,68,68,0.35)',  glow: 'rgba(255,68,68,0.9)'  },
  };

  // ── ORB EMOTION COLORS ──
  // Applied via CSS custom properties on the orb element
  const ORB_STATES = {
    standby:    { color: '#00d4ff', glow: 'rgba(0,212,255,0.9)'   },  // blue
    listening:  { color: '#00ff8c', glow: 'rgba(0,255,140,1)'     },  // green
    thinking:   { color: '#ffb300', glow: 'rgba(255,179,0,1)'     },  // amber
    speaking:   { color: '#ffffff', glow: 'rgba(255,255,255,0.85)' },  // white
    error:      { color: '#ff4444', glow: 'rgba(255,68,68,1)'     },  // red
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

    // Update orb standby glow to match theme
    ORB_STATES.standby.color = theme.primary;
    ORB_STATES.standby.glow  = theme.glow;

    // Re-apply current orb state with new theme color
    applyOrbState(currentOrbState);

    // Update theme buttons in panel
    document.querySelectorAll('.theme-btn').forEach(btn => {
      const active = btn.dataset.theme === themeName;
      btn.style.borderColor = active ? theme.primary : 'rgba(255,255,255,0.1)';
      btn.style.transform   = active ? 'scale(1.12)' : 'scale(1)';
    });
  }

  // ════════════════════════════════════════
  //  ORB EMOTION ENGINE
  // ════════════════════════════════════════
  let currentOrbState = 'standby';

  function applyOrbState(state) {
    currentOrbState = state;
    const orb = document.getElementById('orb');
    if (!orb) return;
    const s = ORB_STATES[state] || ORB_STATES.standby;

    // Remove all state classes
    orb.classList.remove('orb-standby','orb-listening','orb-thinking','orb-speaking','orb-error');
    orb.classList.add(`orb-${state}`);

    // Inject dynamic glow via inline style
    const c = s.color;
    const g = s.glow;

    const glowMap = {
      standby:   `radial-gradient(circle at 38% 32%, rgba(140,230,255,0.95) 0%, rgba(0,140,220,0.7) 35%, rgba(0,20,70,0.95) 75%)`,
      listening: `radial-gradient(circle at 38% 32%, rgba(140,255,200,0.95) 0%, rgba(0,180,100,0.7) 35%, rgba(0,30,15,0.95) 75%)`,
      thinking:  `radial-gradient(circle at 38% 32%, rgba(255,220,100,0.95) 0%, rgba(200,130,0,0.7) 35%, rgba(40,20,0,0.95) 75%)`,
      speaking:  `radial-gradient(circle at 38% 32%, rgba(255,255,255,0.95) 0%, rgba(200,220,255,0.7) 35%, rgba(20,20,40,0.95) 75%)`,
      error:     `radial-gradient(circle at 38% 32%, rgba(255,150,150,0.95) 0%, rgba(200,0,0,0.7) 35%, rgba(40,0,0,0.95) 75%)`,
    };

    orb.style.background  = glowMap[state] || glowMap.standby;
    orb.style.boxShadow   = `0 0 40px ${g}, 0 0 80px ${g.replace('0.9','0.45')}, 0 0 130px ${g.replace('0.9','0.2')}`;
  }

  // Expose so script.js can call it
  window.setOrbState = applyOrbState;

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

  // Override script.js getBestVoice if settings has a saved voice
  function getSelectedVoice() {
    if (settings.voiceName) {
      const found = availableVoices.find(v => v.name === settings.voiceName);
      if (found) return found;
    }
    // fallback to script.js preferred list
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

  // Patch window.speak to use settings voice/rate/pitch
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

  // Patch speakAndType too
  function patchSpeakAndType() {
    if (!window.speakAndType || window.speakAndType._settingsPatched) return;
    const orig = window.speakAndType;
    window.speakAndType = function(el, text, onDone) {
      // temporarily override voices/rate used inside speakAndType
      // by pre-cancelling and re-running with correct settings
      orig(el, text, onDone);
    };
    window.speakAndType._settingsPatched = true;
  }

  function tryPatchSpeak() {
    if (window.speak) { patchSpeak(); }
    else { setTimeout(tryPatchSpeak, 300); }
  }
  tryPatchSpeak();

  // ════════════════════════════════════════
  //  VOICE COMMAND HANDLER
  // ════════════════════════════════════════
  function handleVoice(text) {
    const lower = text.toLowerCase();

    // Open settings
    if (['open settings','show settings','settings','change settings',
         'open preferences','show preferences'].some(p => lower.includes(p))) {
      togglePanel();
      return "Opening settings panel.";
    }

    // Theme commands
    for (const [key, theme] of Object.entries(THEMES)) {
      if (lower.includes(`${key} theme`) || lower.includes(`switch to ${key}`) ||
          lower.includes(`change to ${key}`) || lower.includes(`theme ${key}`)) {
        applyTheme(key);
        return `Switched to ${theme.label} theme.`;
      }
    }

    // Speed commands
    if (['speak faster','talk faster','speed up','faster'].some(p => lower.includes(p))) {
      settings.voiceRate = Math.min(2.0, settings.voiceRate + 0.15);
      saveSettings(); updateSpeedDisplay();
      return `Speaking faster now.`;
    }
    if (['speak slower','talk slower','slow down','slower'].some(p => lower.includes(p))) {
      settings.voiceRate = Math.max(0.5, settings.voiceRate - 0.15);
      saveSettings(); updateSpeedDisplay();
      return `Speaking slower now.`;
    }

    // Pitch commands
    if (['higher pitch','raise your voice','higher voice'].some(p => lower.includes(p))) {
      settings.voicePitch = Math.min(2.0, settings.voicePitch + 0.15);
      saveSettings(); updatePitchDisplay();
      return `Pitch raised.`;
    }
    if (['lower pitch','lower your voice','deeper voice','lower voice'].some(p => lower.includes(p))) {
      settings.voicePitch = Math.max(0.1, settings.voicePitch - 0.15);
      saveSettings(); updatePitchDisplay();
      return `Pitch lowered.`;
    }

    // Reset voice
    if (['reset voice','default voice','reset settings'].some(p => lower.includes(p))) {
      settings.voiceRate  = DEFAULTS.voiceRate;
      settings.voicePitch = DEFAULTS.voicePitch;
      settings.voiceName  = DEFAULTS.voiceName;
      saveSettings(); updateSpeedDisplay(); updatePitchDisplay();
      return `Voice reset to default.`;
    }

    return null;
  }

  // ════════════════════════════════════════
  //  SETTINGS PANEL UI
  // ════════════════════════════════════════
  function ensurePanel() {
    if (document.getElementById('settings-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'settings-panel';
    panel.style.cssText = `
      position:fixed;left:50%;bottom:-560px;
      transform:translateX(-50%);
      width:min(520px,96vw);z-index:60;
      background:rgba(0,2,15,0.98);
      border:1px solid rgba(0,212,255,0.18);
      border-bottom:none;border-radius:6px 6px 0 0;
      transition:bottom 0.4s cubic-bezier(0.22,1,0.36,1);
      font-family:'Share Tech Mono',monospace;
      overflow:hidden;max-height:85vh;overflow-y:auto;
      scrollbar-width:thin;scrollbar-color:rgba(0,212,255,0.2) transparent;
    `;

    panel.innerHTML = `
      <!-- HEADER -->
      <div style="display:flex;justify-content:space-between;align-items:center;
                  padding:16px 20px 12px;border-bottom:1px solid rgba(0,212,255,0.1);
                  position:sticky;top:0;background:rgba(0,2,15,0.98);z-index:1;">
        <span style="font-family:'Orbitron',monospace;font-size:0.65rem;
                     letter-spacing:0.3em;color:var(--cyan,#00d4ff);">⚙ SETTINGS</span>
        <button onclick="window.kairosSettings.togglePanel()"
                style="background:none;border:none;color:rgba(0,212,255,0.4);
                       cursor:pointer;font-size:1rem;transition:color 0.2s;"
                onmouseenter="this.style.color='#00d4ff'"
                onmouseleave="this.style.color='rgba(0,212,255,0.4)'">✕</button>
      </div>

      <!-- THEME SECTION -->
      <div style="padding:16px 20px;border-bottom:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.48rem;letter-spacing:0.25em;color:rgba(0,212,255,0.35);
                    margin-bottom:12px;">🎨 INTERFACE THEME</div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          ${Object.entries(THEMES).map(([key, t]) => `
            <button class="theme-btn" data-theme="${key}"
                    onclick="window.kairosSettings.applyTheme('${key}')"
                    style="width:52px;height:52px;border-radius:50%;
                           background:${t.primary};border:2px solid ${key === settings.theme ? t.primary : 'rgba(255,255,255,0.1)'};
                           cursor:pointer;transition:all 0.2s;
                           transform:${key === settings.theme ? 'scale(1.12)' : 'scale(1)'};
                           box-shadow:0 0 12px ${key === settings.theme ? t.glow : 'transparent'};"
                    title="${t.label}">
            </button>
          `).join('')}
        </div>
        <div id="theme-label" style="font-size:0.48rem;letter-spacing:0.2em;
                                      color:rgba(0,212,255,0.35);margin-top:10px;">
          CURRENT: ${THEMES[settings.theme]?.label || 'CYAN'}
        </div>
      </div>

      <!-- VOICE SECTION -->
      <div style="padding:16px 20px;border-bottom:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.48rem;letter-spacing:0.25em;color:rgba(0,212,255,0.35);
                    margin-bottom:12px;">🗣️ VOICE SELECTION</div>

        <select id="voice-select"
                onchange="window.kairosSettings.setVoice(this.value)"
                style="width:100%;background:rgba(0,212,255,0.04);
                       border:1px solid rgba(0,212,255,0.15);
                       color:rgba(0,212,255,0.8);
                       font-family:'Share Tech Mono',monospace;
                       font-size:0.58rem;padding:8px 10px;outline:none;
                       border-radius:2px;box-sizing:border-box;
                       letter-spacing:0.05em;cursor:pointer;">
          <option value="">Auto (Recommended)</option>
        </select>

        <button onclick="window.kairosSettings.testVoice()"
                style="margin-top:8px;width:100%;
                       background:rgba(0,212,255,0.06);
                       border:1px solid rgba(0,212,255,0.2);
                       color:rgba(0,212,255,0.6);
                       font-family:'Share Tech Mono',monospace;
                       font-size:0.52rem;letter-spacing:0.15em;
                       padding:7px;cursor:pointer;border-radius:2px;
                       transition:background 0.2s;"
                onmouseenter="this.style.background='rgba(0,212,255,0.12)'"
                onmouseleave="this.style.background='rgba(0,212,255,0.06)'">
          ▶ TEST VOICE
        </button>
      </div>

      <!-- SPEED SECTION -->
      <div style="padding:16px 20px;border-bottom:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.48rem;letter-spacing:0.25em;color:rgba(0,212,255,0.35);
                    margin-bottom:12px;">⚡ VOICE SPEED
          <span id="speed-val"
                style="color:var(--cyan,#00d4ff);margin-left:10px;">
            ${settings.voiceRate.toFixed(2)}x
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <button onclick="window.kairosSettings.adjustSpeed(-0.1)"
                  style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);
                         color:rgba(0,212,255,0.7);font-size:1rem;width:36px;height:36px;
                         cursor:pointer;border-radius:2px;transition:background 0.2s;flex-shrink:0;"
                  onmouseenter="this.style.background='rgba(0,212,255,0.14)'"
                  onmouseleave="this.style.background='rgba(0,212,255,0.06)'">−</button>
          <input type="range" id="speed-slider" min="0.5" max="2.0" step="0.05"
                 value="${settings.voiceRate}"
                 oninput="window.kairosSettings.setSpeed(parseFloat(this.value))"
                 style="flex:1;accent-color:var(--cyan,#00d4ff);cursor:pointer;" />
          <button onclick="window.kairosSettings.adjustSpeed(0.1)"
                  style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);
                         color:rgba(0,212,255,0.7);font-size:1rem;width:36px;height:36px;
                         cursor:pointer;border-radius:2px;transition:background 0.2s;flex-shrink:0;"
                  onmouseenter="this.style.background='rgba(0,212,255,0.14)'"
                  onmouseleave="this.style.background='rgba(0,212,255,0.06)'">+</button>
        </div>
      </div>

      <!-- PITCH SECTION -->
      <div style="padding:16px 20px;border-bottom:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.48rem;letter-spacing:0.25em;color:rgba(0,212,255,0.35);
                    margin-bottom:12px;">🎵 VOICE PITCH
          <span id="pitch-val"
                style="color:var(--cyan,#00d4ff);margin-left:10px;">
            ${settings.voicePitch.toFixed(2)}
          </span>
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <button onclick="window.kairosSettings.adjustPitch(-0.1)"
                  style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);
                         color:rgba(0,212,255,0.7);font-size:1rem;width:36px;height:36px;
                         cursor:pointer;border-radius:2px;transition:background 0.2s;flex-shrink:0;"
                  onmouseenter="this.style.background='rgba(0,212,255,0.14)'"
                  onmouseleave="this.style.background='rgba(0,212,255,0.06)'">−</button>
          <input type="range" id="pitch-slider" min="0.1" max="2.0" step="0.05"
                 value="${settings.voicePitch}"
                 oninput="window.kairosSettings.setPitch(parseFloat(this.value))"
                 style="flex:1;accent-color:var(--cyan,#00d4ff);cursor:pointer;" />
          <button onclick="window.kairosSettings.adjustPitch(0.1)"
                  style="background:rgba(0,212,255,0.06);border:1px solid rgba(0,212,255,0.2);
                         color:rgba(0,212,255,0.7);font-size:1rem;width:36px;height:36px;
                         cursor:pointer;border-radius:2px;transition:background 0.2s;flex-shrink:0;"
                  onmouseenter="this.style.background='rgba(0,212,255,0.14)'"
                  onmouseleave="this.style.background='rgba(0,212,255,0.06)'">+</button>
        </div>
      </div>

      <!-- RESET -->
      <div style="padding:14px 20px 20px;">
        <button onclick="window.kairosSettings.resetAll()"
                style="width:100%;background:rgba(255,68,68,0.06);
                       border:1px solid rgba(255,68,68,0.2);
                       color:rgba(255,68,68,0.6);
                       font-family:'Share Tech Mono',monospace;
                       font-size:0.52rem;letter-spacing:0.2em;
                       padding:8px;cursor:pointer;border-radius:2px;
                       transition:background 0.2s;"
                onmouseenter="this.style.background='rgba(255,68,68,0.12)'"
                onmouseleave="this.style.background='rgba(255,68,68,0.06)'">
          ↺ RESET ALL TO DEFAULT
        </button>
        <div style="font-size:0.42rem;letter-spacing:0.12em;color:rgba(0,212,255,0.18);
                    margin-top:10px;text-align:center;line-height:2;">
          SAY: "switch to amber theme" · "speak faster" · "lower your voice"<br>
          PRESS <span style="color:rgba(0,212,255,0.4);">G</span> TO OPEN / CLOSE
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    renderVoiceSelect();
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
    const el  = document.getElementById('speed-val');
    const sl  = document.getElementById('speed-slider');
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
    ensurePanel();
    const panel = document.getElementById('settings-panel');
    if (!panel) return;
    panelOpen = !panelOpen;
    panel.style.bottom = panelOpen ? '0' : '-560px';
    const btn = document.getElementById('set-btn');
    if (btn) btn.classList.toggle('active', panelOpen);
    if (panelOpen) {
      renderVoiceSelect();
      updateSpeedDisplay();
      updatePitchDisplay();
    }
  }

  // ════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════
  window.kairosSettings = {
    togglePanel,
    handleVoice,
    applyTheme,
    setOrbState: applyOrbState,

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
      updateSpeedDisplay();
      updatePitchDisplay();
      renderVoiceSelect();
      if (typeof window.speak === 'function')
        window.speak("Settings reset to default.");
    },

    getRate()  { return settings.voiceRate;  },
    getPitch() { return settings.voicePitch; },
    getVoice() { return getSelectedVoice();  },
  };

  // ════════════════════════════════════════
  //  KEYBOARD SHORTCUT  G
  // ════════════════════════════════════════
  document.addEventListener('keydown', e => {
    if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === 'g' || e.key === 'G') togglePanel();
  });

  // ── WIRE SETTINGS BUTTON IN HUD ──
  function wireSettingsBtn() {
    const btn = document.getElementById('set-btn');
    if (btn && !btn._setWired) {
      btn.addEventListener('click', togglePanel);
      btn._setWired = true;
    }
  }

  // ════════════════════════════════════════
  //  INIT — apply saved theme on load
  // ════════════════════════════════════════
  function init() {
    applyTheme(settings.theme);
    ensurePanel();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireSettingsBtn);
    } else {
      wireSettingsBtn();
    }
    // patch speak after script.js loads
    setTimeout(tryPatchSpeak, 800);
  }

  init();

})();