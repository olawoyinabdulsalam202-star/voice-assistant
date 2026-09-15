// ════════════════════════════════════════
//  script.js  —  KAIROS CORE  v14
//  New:
//  • Orb state engine wired (setOrbState)
//    standby / listening / thinking / speaking / error
//  FIXES APPLIED THIS PASS:
//  • resumeAfterReply no longer shadowed by a broken nested
//    duplicate inside the REMINDERS branch of processCommand
//  • checkVoiceCommand now signals 'FILE_HANDLED' instead of
//    undefined, so file-command replies aren't talked over by
//    a second, unrelated AI reply
//  • keydown shortcuts (h/c/s/d/r/m/f) now ignore keystrokes
//    while an input/textarea/contenteditable is focused
//  • addToHistory now escapes text before inserting into innerHTML
// ════════════════════════════════════════

// ── ORB STATE HELPER ──
// Single function so every state change goes through settings.js
function setOrb(state) {
  if (typeof window.setOrbState === 'function') {
    window.setOrbState(state);
  } else {
    // Fallback: legacy class toggle while settings.js loads
    const o = document.getElementById('orb');
    if (!o) return;
    o.classList.remove('orb-standby','orb-listening','orb-thinking','orb-speaking','orb-error','listening');
    if (state === 'listening') o.classList.add('listening');
  }
}

// ── BACKGROUND ──
// The WebGL point-cloud starfield was retired. The shared .kx-bg
// (gradient + faint grain + soft accent glow) is now the only atmosphere,
// matching every other page in the app. No three.js is loaded.

// ── FETCH PLAN STATUS ON LOAD (so Memory/File gating works immediately) ──
(async function primePlanStatus() {
  try {
    const token = localStorage.getItem('kairos_token') || '';
    if (!token) return;
    const r = await fetch('/api/user/me', { headers: { 'Authorization': `Bearer ${token}` } });
    if (r.ok) {
      const user = await r.json();
      window.KAIROS_IS_PRO = !!user.is_pro;
      window.KAIROS_PROFILE = user;
    }
  } catch (e) { /* leave undefined — gated actions will check when clicked */ }
})();

// Keep admin-edited free limits live in an already-open /app tab.
setInterval(async () => {
  if (document.hidden) return;
  try {
    const response = await fetch('/api/config/public', { cache: 'no-store' });
    if (response.ok) {
      const config = await response.json();
      window.KAIROS_LIMITS = config.limits || window.KAIROS_LIMITS || {};
    }
  } catch (e) { /* retain the last known limits while offline */ }
}, 10000);

(async function primeConversationHistory() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('new') === '1') {
    await startNewConversation();
    history.replaceState(null, '', '/app');
  } else {
    await loadCurrentConversation();
  }
})();

// ── REVEAL INTERFACE ──
function revealInterface(options) {
  const immediate = options && options.immediate;
  const vl = document.getElementById('video-layer');
  vl.classList.add('fade-out');
  document.getElementById('skip-btn').style.display = 'none';
  setTimeout(async () => {
    vl.style.display = 'none';
    document.getElementById('interface').classList.add('visible');
    document.getElementById('strip').style.opacity = '1';
    ['c1', 'c2', 'c3', 'c4'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('show');
    });

    // Wait for server config so wake words / shortcuts / limits are in
    // place before the listeners start (C2/C5/C6).
    try { await window.KAIROS_CONFIG_READY; } catch (e) { }

    setOrb('standby');
    autoGreet();
    loadUserNotifications();
    applyMuteVisuals();

    // M4: honour a mute saved from a previous session — do NOT open the
    // mic just because the page reloaded.
    if (!isMicMuted) {
      startWakeWordListener();
      startClapDetection();
    }

    startClock();
    window.kairosReminders?.init();
    await buildDeviceSelector();
    autoConnectSavedDevices();
  }, immediate ? 0 : 250);
}

async function loadUserNotifications() {
  const token = localStorage.getItem('kairos_token') || '';
  if (!token) return;
  try {
    const r = await fetch('/api/notifications', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
    const data = await r.json();
    const n = (data.notifications || [])[0];
    if (!n) return;
    const banner = document.createElement('div');
    // Redesign: shared glass notification family, corner variant (was a
    // cyan #07111d card). Structure/sanitisation/handlers unchanged.
    banner.className = 'kx-notice kx-notice--corner';
    banner.innerHTML = `<b class="kx-notice__title">${String(n.subject || 'KAIROS').replace(/[<>]/g, '')}</b><div class="kx-notice__body">${String(n.body || '').replace(/[<>]/g, '')}</div><button type="button" class="glass-btn glass-btn--sm glass-btn--outline kx-notice__close-btn" aria-label="Close notification">CLOSE</button>`;
    banner.querySelector('button').onclick = () => { banner.remove(); fetch('/api/notifications/' + n.id + '/read', {method:'PATCH', headers:{Authorization:`Bearer ${token}`}}).catch(() => {}); };
    document.body.appendChild(banner);
  } catch (e) { /* notifications are supplementary */ }
}

// ── VIDEO LOGIC ──
const vid = document.getElementById('intro-video');
const hasVideo = vid && vid.getAttribute('src') && vid.getAttribute('src') !== '';
const skipIntro = new URLSearchParams(window.location.search).get('skip_intro') === '1';
if (skipIntro) {
  if (vid) { vid.pause(); vid.style.display = 'none'; }
  revealInterface({ immediate: true });
  history.replaceState(null, '', '/app');
} else if (hasVideo) {
  vid.play().catch(() => setTimeout(revealInterface, 500));
  vid.addEventListener('ended', revealInterface);
  setTimeout(() => { const sb = document.getElementById('skip-btn'); if (sb) sb.classList.add('show'); }, 2000);
  const skipBtn = document.getElementById('skip-btn');
  if (skipBtn) skipBtn.addEventListener('click', () => { vid.pause(); revealInterface(); });
} else {
  const fb = document.getElementById('fallback');
  if (fb) fb.classList.add('show');
  if (vid) vid.style.display = 'none';
  setTimeout(revealInterface, 5200);
}

// ── ELEMENTS ──
const greetingEl = document.getElementById('greeting');
const statusEl = document.getElementById('status');
const orb = document.getElementById('orb');

// ── AUTO GREETING ──
function autoGreet() {
  const h = new Date().getHours();
  const t = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
  const uname = (window.getKairosName && window.getKairosName()) || "friend";
  const msg = `Good ${t}, ${uname}. Say "Hey Kairos" or clap twice to activate me.`;
  speakAndType(greetingEl, msg, () => { });
  statusEl.textContent = '▶ STANDBY — SAY "HEY KAIROS" OR CLAP TWICE';
}

// ════════════════════════════════════════
//  SECURITY — INPUT SANITIZATION
// ════════════════════════════════════════
function sanitizeInput(text) {
  if (!text || typeof text !== 'string') return '';
  return text.slice(0, 1000).replace(/[<>]/g, '').trim();
}

// ════════════════════════════════════════
//  CLEAN TEXT FOR SPEECH
// ════════════════════════════════════════
function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, 'Here is the code.')
    .replace(/`[^`]*`/g, match => match.replace(/`/g, ''))
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/#{1,6}\s/g, '')
    .replace(/>\s/g, '')
    .replace(/[-_]{2,}/g, '')
    .replace(/\\\\/g, '')
    .replace(/\\/g, '')
    .replace(/\|/g, ', ')
    .replace(/\n{2,}/g, '. ')
    .replace(/\n/g, ' ')
    .trim();
}

function hasCodeBlock(text) { return !!text && text.includes('```'); }

function extractCodeBlocks(text) {
  const blocks = [];
  const regex = /```(\w*)\n?([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    blocks.push({ lang: match[1] || 'code', code: match[2].trim() });
  }
  return blocks;
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function showCodePanel(blocks) {
  let panel = document.getElementById('code-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'code-panel';
    // Redesign: glass output panel (was a cyan #000514 monospace box).
    // Kept as a display-toggle panel so the inline close onclick below
    // stays byte-for-byte unchanged.
    panel.className = 'kx-code-panel kx-scroll';
    document.body.appendChild(panel);
  }
  panel.innerHTML = `
    <div class="kx-code-panel__head">
      <span class="kx-code-panel__title"><svg class="ic ic--sm" aria-hidden="true"><use href="/icons.svg#ic-code"/></svg> CODE OUTPUT</span>
      <button class="kx-code-panel__btn" onclick="document.getElementById('code-panel').style.display='none'"><svg class="ic ic--sm" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg> CLOSE</button>
    </div>
    ${blocks.map(b => `
      <div class="kx-code-panel__block">
        <div class="kx-code-panel__lang">
          <span>${b.lang.toUpperCase() || 'CODE'}</span>
          <button class="kx-code-panel__btn" onclick="navigator.clipboard.writeText(this.closest('div').nextElementSibling.textContent).then(()=>{this.textContent='✓ COPIED';setTimeout(()=>this.textContent='COPY',1500)})">COPY</button>
        </div>
        <pre class="kx-code-panel__pre">${escapeHtml(b.code)}</pre>
      </div>
    `).join('')}
  `;
  panel.style.display = 'block';
  setTimeout(() => { if (panel) panel.style.display = 'none'; }, 60000);
}

// ════════════════════════════════════════
//  VOICE LOADER
// ════════════════════════════════════════
let _voicesReady = false;
let _voicesList = [];
function loadVoices() {
  _voicesList = window.speechSynthesis.getVoices();
  if (_voicesList.length > 0) _voicesReady = true;
}
loadVoices();
window.speechSynthesis.onvoiceschanged = loadVoices;

function getBestVoice() {
  const preferred = ['Google UK English Male', 'Microsoft Ryan Online (Natural) - English (United Kingdom)', 'Microsoft Guy Online (Natural) - English (United States)', 'Daniel', 'Arthur', 'Google US English', 'Alex'];
  for (const name of preferred) {
    const found = _voicesList.find(v => v.name.includes(name));
    if (found) return found;
  }
  return _voicesList.find(v => /en/i.test(v.lang) && /male/i.test(v.name)) || null;
}

// ════════════════════════════════════════
//  SPEAK + TYPE
// ════════════════════════════════════════
let typingInterval = null;
let isSpeaking = false;
let lastSpokenReply = '';
let speechGeneration = 0;
let speechEchoGuardUntil = 0;

function pauseRecognitionForSpeech() {
  if (!mainRec) return;
  try {
    mainRec.onend = null;
    mainRec.onerror = null;
    mainRec.onresult = null;
    mainRec.abort();
  } catch (e) { }
  mainRec = null;
  mainRecActive = false;
}

function speakAndType(el, text, onDone) {
  const generation = ++speechGeneration;
  pauseRecognitionForSpeech();
  if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
  window.speechSynthesis.cancel();
  isSpeaking = false;
  el.textContent = '';
  const spokenText = cleanForSpeech(text);
  const displayText = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/#{1,6}\s/g, '').replace(/`/g, '').trim();
  let doneFired = false;
  function fireDone() {
    if (generation !== speechGeneration) return;
    if (doneFired) return; doneFired = true;
    isSpeaking = false; el.textContent = displayText;
    speechEchoGuardUntil = Date.now() + 900;
    if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
    if (onDone) onDone();
  }
  function doSpeak() {
    const u = new SpeechSynthesisUtterance(spokenText);
    u.rate = 1.05; u.pitch = 0.85; u.volume = 1;
    const voice = getBestVoice();
    if (voice) u.voice = voice;
    u.onstart = () => {
      isSpeaking = true;
      if (typingInterval) clearInterval(typingInterval);
      const wordCount = displayText.split(' ').length;
      const speechMs = (wordCount / 2.4) * 1000 / u.rate;
      const charDelay = Math.max(15, Math.min(50, speechMs / displayText.length));
      let i = 0;
      typingInterval = setInterval(() => {
        if (i < displayText.length) { el.textContent += displayText[i++]; }
        else { clearInterval(typingInterval); typingInterval = null; }
      }, charDelay);
    };
    u.onend = fireDone; u.onerror = fireDone;
    setTimeout(fireDone, Math.max(4000, (spokenText.split(' ').length / 2.4) * 1000 * (1 / u.rate) * 1.4));
    window.speechSynthesis.speak(u);
  }
  if (_voicesReady) { doSpeak(); }
  else { const ws = Date.now(); const vc = setInterval(() => { loadVoices(); if (_voicesReady || Date.now() - ws > 1500) { clearInterval(vc); doSpeak(); } }, 100); }
}

function stopKairos() {
  speechGeneration++;
  window.speechSynthesis.cancel();
  isSpeaking = false;
  if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
}

function speak(text, onDone) {
  if (!('speechSynthesis' in window)) { if (onDone) onDone(); return; }
  const generation = ++speechGeneration;
  pauseRecognitionForSpeech();
  window.speechSynthesis.cancel();
  isSpeaking = false;
  let doneFired = false;
  function fireDone() {
    if (generation !== speechGeneration || doneFired) return;
    doneFired = true;
    isSpeaking = false;
    speechEchoGuardUntil = Date.now() + 900;
    if (onDone) onDone();
    else if (isAwake && !isProcessing && !isMicMuted) setTimeout(startMainListener, 1000);
  }
  function doSpeak() {
    const u = new SpeechSynthesisUtterance(cleanForSpeech(text));
    u.rate = 1.05; u.pitch = 0.85; u.volume = 1;
    const voice = getBestVoice();
    if (voice) u.voice = voice;
    u.onstart = () => { isSpeaking = true; };
    u.onend = fireDone; u.onerror = fireDone;
    setTimeout(fireDone, 6000);
    window.speechSynthesis.speak(u);
  }
  if (_voicesReady) { doSpeak(); }
  else { const ws = Date.now(); const vc = setInterval(() => { loadVoices(); if (_voicesReady || Date.now() - ws > 1500) { clearInterval(vc); doSpeak(); } }, 100); }
}

// Stable voice controls shared by the web UI and future Android/desktop
// wrappers. Consumers can interrupt speech without knowing implementation
// details such as SpeechSynthesis or recognition instances.
window.kairosVoice = {
  stop: stopKairos,
  speak,
  speakAndType,
  isSpeaking: () => isSpeaking,
  interrupt: () => {
    interactionGeneration++;
    stopKairos();
    isProcessing = false;
    mainRecActive = false;
    statusEl.textContent = '▶ ACTIVE — SAY SOMETHING ELSE';
    setOrb('listening');
    if (isAwake) setTimeout(startMainListener, 350);
  }
};

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && isSpeaking) window.kairosVoice.interrupt();
});

// ════════════════════════════════════════
//  DEVELOPER CREDITS
// ════════════════════════════════════════
const DEV_KEYWORDS = ['who made you', 'who built you', 'who developed you', 'who created you', 'who is your developer', 'who designed you', 'who programmed you', 'who are you built by', 'your creator', 'your developer', 'who owns you', 'who is your owner', 'who is your maker', 'who is your founder'];
const DEV_RESPONSE = `I was built by Mr Abdulsalam — a web developer and AI developer based in Lagos, Nigeria, operating under the brand Elite Dev. He specialises in premium frontend and backend experiences, AI-powered interfaces, and JavaScript and Python development.`;
function checkDevQuestion(text) { return DEV_KEYWORDS.some(kw => text.toLowerCase().includes(kw)); }

// ════════════════════════════════════════
//  VOICE COMMAND DETECTION
// ════════════════════════════════════════
function checkVoiceCommand(text) {
  const lower = text.toLowerCase();
  if (['enough', 'that is enough', "that's enough", 'stop talking', 'be quiet',
       'let us move on', "let's move on", 'move on'].some(p => lower.includes(p))) return 'INTERRUPT';
  const fileReply = window.kairosFiles?.handleVoice(text);
  if (fileReply) { speak(fileReply); return 'FILE_HANDLED'; }
  if (['turn on camera', 'open camera', 'activate camera', 'enable camera', 'start camera', 'show camera', 'camera on'].some(p => lower.includes(p))) return 'CAMERA_ON';
  if (['turn off camera', 'close camera', 'disable camera', 'stop camera', 'camera off'].some(p => lower.includes(p))) return 'CAMERA_OFF';
  if (['share my screen', 'share screen', 'start screen share', 'screen sharing', 'show my screen'].some(p => lower.includes(p))) return 'SCREEN_ON';
  if (['stop sharing', 'stop screen share', 'close screen', 'end screen share'].some(p => lower.includes(p))) return 'SCREEN_OFF';
  if (['open history', 'show history', 'show log', 'open log', 'conversation log', 'show conversation'].some(p => lower.includes(p))) return 'HISTORY_OPEN';
  if (['close history', 'hide history', 'close log'].some(p => lower.includes(p))) return 'HISTORY_CLOSE';
  if (['show devices', 'open devices', 'device settings', 'change microphone', 'change camera', 'switch mic', 'switch camera'].some(p => lower.includes(p))) return 'DEVICES_OPEN';
  if (['go to sleep', 'sleep', 'goodbye kairos', 'goodbye', 'good night kairos', 'good night k', 'kairos sleep', 'standby'].some(p => lower.includes(p))) return 'SLEEP';
  return null;
}

async function handleVoiceCommand(cmd) {
  switch (cmd) {
    case 'INTERRUPT':
      window.kairosVoice.interrupt();
      return true;
    case 'CAMERA_ON':
      if (!cameraStream) {
        const ok = await openCamera(selectedCamId);
        speak(ok ? `Camera activated, ${(window.getKairosName && window.getKairosName()) || "friend"}.` : "I couldn't access the camera.");
      } else { speak("Camera is already on."); }
      return true;
    case 'CAMERA_OFF':
      closeCamera(); speak("Camera deactivated."); return true;
    case 'SCREEN_ON':
      if (!screenStream) {
        speak("Opening screen share now.", async () => {
          const ok = await startScreenShare();
          if (!ok) speak("Screen sharing was cancelled.");
        });
      } else { speak("Screen is already being shared."); }
      return true;
    case 'SCREEN_OFF':
      stopScreenShare(); speak("Screen sharing stopped."); return true;
    case 'HISTORY_OPEN':
      toggleHistory(); speak("Conversation log opened."); return true;
    case 'HISTORY_CLOSE':
      toggleHistory(); speak("Conversation log closed."); return true;
    case 'DEVICES_OPEN':
      toggleDevicePanel(); speak("Device settings opened."); return true;
    case 'SLEEP':
      speak("Going to standby. Say Hey Kairos whenever you need me.", () => sleepKairos()); return true;
    default: return false;
  }
}

// ════════════════════════════════════════
//  VISION / SCREEN DETECTION
// ════════════════════════════════════════
function isVisionRequest(text) {
  const lower = text.toLowerCase();
  const visualVerbs = ['see', 'look', 'watch', 'view', 'observe', 'notice', 'spot', 'identify', 'recognise', 'recognize', 'analyse', 'analyze', 'describe', 'examine', 'inspect', 'check'];
  const visualContext = ['camera', 'screen', 'image', 'photo', 'picture', 'frame', 'front of me', 'in front', 'this', 'here', 'my work', 'my project', 'my code', 'my circuit', 'my robot', 'what i', 'what am i', 'what is this', 'what are these'];
  const directPhrases = ['what do you see', 'what can you see', 'look at this', 'look at my', 'what is this', 'what are these', 'describe this', 'describe what', 'can you see', 'tell me what you see', 'what do you notice', 'analyse this', 'analyze this', 'examine this', 'inspect this', 'what am i holding', 'what am i working on', 'what is in front', 'show me what', 'look through my camera', 'use your camera', 'what does this look like', 'identify this', 'identify what'];
  const hasVerb = visualVerbs.some(v => lower.includes(v));
  const hasContext = visualContext.some(c => lower.includes(c));
  return directPhrases.some(p => lower.includes(p)) || (hasVerb && hasContext);
}

function isScreenRequest(text) {
  const lower = text.toLowerCase();
  return ['my screen', 'look at my screen', 'what\'s on my screen', 'check my screen', 'analyse my screen', 'analyze my screen', 'what do you see on screen', 'my assignment', 'my website', 'my code on screen', 'fix my code', 'review my code', 'help with my design', 'look at my design', 'check my design'].some(p => lower.includes(p));
}

// ════════════════════════════════════════
//  STATE
// ════════════════════════════════════════
let wakeRec = null;
let mainRec = null;
let isAwake = false;
let isProcessing = false;
let interactionGeneration = 0;
let sleepTimer = null;
let wakeDebounce = false;
let mainRecActive = false;
let restartPending = false;

// M3/M4: restored from localStorage so mute survives a reload. This
// flag is checked INSIDE buildWakeRec() and startMainListener() —
// wakeRec.onend auto-restarts after 400ms, so without the guard a
// mute would silently undo itself half a second later.
let isMicMuted = (function () {
  try { return localStorage.getItem('kairos_mic_muted') === '1'; }
  catch (e) { return false; }
})();

const ACTIVE_TIMEOUT_MS = 60000;

// ════════════════════════════════════════
//  WAKE WORDS
//
//  C5: sourced from server config. persona.json already had a
//  "wake_word" field and the admin panel could edit it — but this file
//  used its own hardcoded array and ignored it entirely, so that
//  editor wrote to a value nothing ever read. The list below is now
//  only the offline fallback.
// ════════════════════════════════════════
const FALLBACK_WAKE_WORDS = [
  'kairos', 'hey kairos', 'wake up kairos',
  'rise kairos', 'kairos awaken', 'engage kairos',
  'kairos online', 'activate kairos',
];

function getWakeWords() {
  const fromConfig = (window.KAIROS_WAKE && window.KAIROS_WAKE.words) || null;
  if (Array.isArray(fromConfig) && fromConfig.length) return fromConfig;
  return FALLBACK_WAKE_WORDS;
}

function isWakeWord(transcript) {
  const lower = transcript.toLowerCase().trim();
  return getWakeWords().some(w => lower.includes(String(w).toLowerCase()));
}

// ════════════════════════════════════════
//  MIC MUTE  (M1-M7)
//
//  Note: the pre-existing camera/screen "mute" buttons called
//  kairosCore.sleep()/wake(), which ended the whole session — and
//  wake() speaks "Yes, how can I help?", so unmuting talked at you.
//  This is a real mute: listeners stop, the mic is released, and
//  resuming is silent.
// ════════════════════════════════════════
function isMuted() { return isMicMuted; }

function applyMuteVisuals() {
  const btn = document.getElementById('mic-mute-btn');
  if (btn) {
    // The icons are inline SVG children, so only the class is toggled —
    // setting textContent here would destroy them.
    btn.classList.toggle('muted', isMicMuted);
    btn.setAttribute('aria-pressed', isMicMuted ? 'true' : 'false');
    const label = isMicMuted ? 'Unmute microphone' : 'Mute microphone';
    btn.setAttribute('title', label);
    btn.setAttribute('aria-label', label);
  }
  // M6: unmistakable state, not just an icon swap.
  const orbEl = document.getElementById('orb');
  if (orbEl) orbEl.classList.toggle('mic-muted', isMicMuted);

  if (statusEl) {
    if (isMicMuted) {
      statusEl.textContent =
        (window.KAIROS_UI && window.KAIROS_UI.status_mic_muted) ||
        '▶ MIC MUTED — TAP TO RESUME';
    } else if (!isAwake) {
      statusEl.textContent =
        (window.KAIROS_UI && window.KAIROS_UI.status_standby) ||
        '▶ STANDBY — SAY "HEY KAIROS" OR CLAP TWICE';
    }
  }
}

function muteMic(options) {
  const silent = options && options.silent;
  isMicMuted = true;
  try { localStorage.setItem('kairos_mic_muted', '1'); } catch (e) { }

  // Stop everything that holds the microphone.
  isAwake = false;
  clearTimeout(sleepTimer);
  stopKairos();

  if (wakeRec) {
    try { wakeRec.onend = null; wakeRec.onerror = null; wakeRec.onresult = null; wakeRec.abort(); }
    catch (e) { }
    wakeRec = null;
  }
  if (mainRec) {
    try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); }
    catch (e) { }
    mainRec = null;
  }
  mainRecActive = false;
  restartPending = false;

  stopClapDetection();   // M2 — this is what clears the OS mic light
  setOrb('standby');
  applyMuteVisuals();

  if (!silent && typeof showNotification === 'function') {
    showNotification(
      (window.KAIROS_UI && window.KAIROS_UI.mic_muted_notice) ||
      'Microphone muted. I won\'t listen until you unmute.'
    );
  }
}

function unmuteMic(options) {
  const silent = options && options.silent;
  isMicMuted = false;
  try { localStorage.removeItem('kairos_mic_muted'); } catch (e) { }

  applyMuteVisuals();

  // M5: restart listening WITHOUT the "Yes, how can I help?" greeting.
  buildWakeRec();
  startClapDetection();

  if (!silent && typeof showNotification === 'function') {
    showNotification(
      (window.KAIROS_UI && window.KAIROS_UI.mic_unmuted_notice) ||
      'Microphone active.'
    );
  }
}

function toggleMicMute() {
  if (isMicMuted) unmuteMic();
  else muteMic();
  return isMicMuted;
}

function openKairosSettings() {
  if (document.getElementById('kairos-settings-overlay')) return;

  const wasMuted = isMicMuted;
  if (!wasMuted) muteMic({ silent: true });

  const overlay = document.createElement('div');
  overlay.id = 'kairos-settings-overlay';
  overlay.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:20000', 'background:var(--bg-base-start)',
    'display:flex', 'flex-direction:column'
  ].join(';');

  const frame = document.createElement('iframe');
  frame.src = '/settings?embedded=1';
  frame.title = 'KAIROS settings';
  frame.style.cssText = 'width:100%;height:100%;border:0;background:var(--bg-base-start)';
  overlay.appendChild(frame);
  document.body.appendChild(overlay);

  const close = () => {
    overlay.remove();
    window.removeEventListener('message', onMessage);
    if (!wasMuted) unmuteMic({ silent: true });
  };
  const onMessage = (event) => {
    if (event.origin === window.location.origin && event.data === 'kairos:close-settings') close();
  };
  window.addEventListener('message', onMessage);
}

window.openKairosSettings = openKairosSettings;

window.kairosMic = {
  mute: muteMic,
  unmute: unmuteMic,
  toggle: toggleMicMute,
  isMuted: isMuted,
};

// ════════════════════════════════════════
//  CLAP DETECTION
//
//  M2: the stream and AudioContext are now kept in module scope so
//  mute can actually STOP them. Previously getUserMedia opened a mic
//  stream at startup that was never released, so the browser/OS mic
//  indicator stayed lit for the entire session with no way to turn it
//  off short of closing the tab.
// ════════════════════════════════════════
let clapStream = null;
let clapCtx = null;
let clapInterval = null;

async function startClapDetection() {
  const wakeCfg = window.KAIROS_WAKE || {};
  if (wakeCfg.clap_enabled === false) return;
  if (isMicMuted) return;
  if (clapStream) return;   // already running

  const threshold = wakeCfg.clap_volume_threshold || 75;
  const windowMs  = wakeCfg.clap_window_ms || 800;
  const cooldownMs = wakeCfg.clap_cooldown_ms || 2000;

  try {
    clapStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    clapCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = clapCtx.createMediaStreamSource(clapStream);
    const analyser = clapCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let lastClap = 0;
    let clapCount = 0;
    let clapCooldown = false;

    clapInterval = setInterval(() => {
      if (isMicMuted || isAwake || clapCooldown) return;
      analyser.getByteFrequencyData(buffer);
      const volume = buffer.reduce((a, b) => a + b) / buffer.length;

      if (volume > threshold) {
        const now = Date.now();
        if (now - lastClap < windowMs) {
          clapCount++;
          if (clapCount >= 2) {
            clapCount = 0;
            clapCooldown = true;
            setTimeout(() => { clapCooldown = false; }, cooldownMs);
            orb.style.transform = 'scale(1.2)';
            setTimeout(() => { orb.style.transform = ''; }, 200);
            if (!isAwake && !isProcessing && !wakeDebounce) {
              wakeDebounce = true;
              setTimeout(() => { wakeDebounce = false; }, 2500);
              activateKairos();
            }
          }
        } else {
          clapCount = 1;
        }
        lastClap = now;
      }
    }, 80);

  } catch (err) {
    console.warn('Clap detection unavailable:', err.name);
  }
}

// M2: fully release the mic. Stopping the tracks is what actually
// turns off the OS indicator — clearing the interval alone would leave
// the light on and users would not believe the mute worked.
function stopClapDetection() {
  if (clapInterval) { clearInterval(clapInterval); clapInterval = null; }
  if (clapStream) {
    clapStream.getTracks().forEach(t => t.stop());
    clapStream = null;
  }
  if (clapCtx) {
    try { clapCtx.close(); } catch (e) { }
    clapCtx = null;
  }
}

// ════════════════════════════════════════
//  WAKE WORD LISTENER
// ════════════════════════════════════════
function startWakeWordListener() {
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    statusEl.textContent = '▶ VOICE NOT SUPPORTED — USE CHROME'; return;
  }
  buildWakeRec();
}

function buildWakeRec() {
  if (isAwake) return;
  if (isMicMuted) return;   // M3 — the guard that makes mute stick
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  try { if (wakeRec) { wakeRec.onend = null; wakeRec.onerror = null; wakeRec.onresult = null; wakeRec.abort(); } } catch (e) { }

  wakeRec = new SR();
  wakeRec.continuous = true; wakeRec.interimResults = true;
  wakeRec.lang = (window.KAIROS_SPEECH_LANGUAGE || navigator.language || 'en-US');

  wakeRec.onresult = (e) => {
    if (isAwake || isMicMuted) return;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (isWakeWord(t) && !wakeDebounce && !isProcessing) {
        wakeDebounce = true;
        setTimeout(() => { wakeDebounce = false; }, 2500);
        activateKairos(); return;
      }
    }
  };

  // These auto-restart handlers are exactly why isMicMuted has to be
  // checked in buildWakeRec — otherwise onend fires 400ms after mute
  // and quietly turns the mic back on.
  wakeRec.onend = () => { if (!isAwake && !isMicMuted) setTimeout(buildWakeRec, 400); };
  wakeRec.onerror = (e) => {
    if (e.error !== 'no-speech') console.warn('Wake:', e.error);
    if (!isAwake && !isMicMuted) setTimeout(buildWakeRec, 800);
  };
  try { wakeRec.start(); } catch (e) { if (!isMicMuted) setTimeout(buildWakeRec, 800); }
}

// ════════════════════════════════════════
//  ACTIVATE KAIROS
// ════════════════════════════════════════
function activateKairos() {
  if (isMicMuted) {
    // Clicking the orb while muted should unmute rather than appear broken.
    unmuteMic();
    return;
  }
  isAwake = true;
  clearTimeout(sleepTimer);
  try { wakeRec.onend = null; wakeRec.abort(); } catch (e) { }

  setOrb('listening');                                    // ← ORB: listening
  statusEl.textContent = '▶ LISTENING...';
  greetingEl.textContent = '';
  speak(
    (window.KAIROS_UI && window.KAIROS_UI.activation_reply) || "Yes, how can I help?",
    // Give the browser audio output time to drain before opening the mic.
    // Without this gap Chrome can feed the activation phrase back as input.
    () => { setTimeout(startMainListener, 1000); }
  );
}

// ════════════════════════════════════════
//  MAIN LISTENER
// ════════════════════════════════════════
function startMainListener() {
  if (!isAwake || isProcessing) return;
  if (isMicMuted) return;   // M3
  if (mainRecActive || restartPending) return;
  restartPending = true;

  setTimeout(() => {
    restartPending = false;
    if (!isAwake || isProcessing || isMicMuted) return;

    if (mainRec) {
      try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); } catch (e) { }
      mainRec = null;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    mainRec = new SR();
    mainRec.lang = (window.KAIROS_SPEECH_LANGUAGE || navigator.language || 'en-US');
    mainRec.continuous = true; mainRec.interimResults = true; mainRec.maxAlternatives = 3;

    let silenceTimer = null, finalText = '', interimText = '';
    const SILENCE_MS = 1400;

    mainRec.onstart = () => {
      mainRecActive = true;
      setOrb('listening');                                // ← ORB: listening
      statusEl.textContent = screenStream ? '▶ LISTENING — SCREEN ON' : cameraStream ? '▶ LISTENING — CAMERA ON' : '▶ LISTENING...';
    };

    mainRec.onresult = (e) => {
      interimText = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) { finalText += t + ' '; interimText = ''; }
        else { interimText = t; }
      }
      const display = (finalText + interimText).trim();

      if (Date.now() < speechEchoGuardUntil) return;

      // ignore Kairos hearing its own voice
      const normalized = display.toLowerCase();
      if (normalized.length > 1 && lastSpokenReply.includes(normalized) && normalized.length < 40) {
        return;
      }

      if (display) greetingEl.textContent = `"${display}"`;
      if (isSpeaking && display.length > 1) { stopKairos(); statusEl.textContent = '▶ LISTENING...'; }
      if (silenceTimer) clearTimeout(silenceTimer);
      if (!isProcessing) {
        silenceTimer = setTimeout(() => {
          const command = (finalText + interimText).trim();
          if (command.length > 1) { finalText = ''; interimText = ''; processCommand(command); }
        }, SILENCE_MS);
      }
    };

    mainRec.onend = () => {
      mainRecActive = false;
      // Only remove listening state if we're not about to restart
      if (!isAwake || isProcessing) setOrb(isAwake ? 'thinking' : 'standby');
      if (isAwake && !isProcessing && !restartPending) startMainListener();
    };

    mainRec.onerror = (e) => {
      mainRecActive = false;
      if (e.error === 'aborted') return;
      if (e.error === 'no-speech') { if (isAwake && !isProcessing) startMainListener(); return; }
      console.warn('mainRec error:', e.error);
      if (isAwake && !isProcessing) setTimeout(() => startMainListener(), 500);
    };

    try { mainRec.start(); }
    catch (e) { mainRecActive = false; setTimeout(() => { if (isAwake && !isProcessing) startMainListener(); }, 500); }
  }, 150);
}

// ════════════════════════════════════════
//  PROCESS COMMAND
// ════════════════════════════════════════
async function processCommand(rawInput) {
  if (isProcessing) return;
  const generation = ++interactionGeneration;

  const userSaid = sanitizeInput(rawInput);
  if (!userSaid) return;

  // ── REMINDERS ──
  if (window.kairosReminders) {
    const remReply = await window.kairosReminders.handleVoice(userSaid);
    if (remReply) {
      addToHistory('user', userSaid);
      isProcessing = true;
      if (mainRec) {
        try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); } catch (e) { }
        mainRec = null;
      }
      mainRecActive = false;
      setOrb('speaking');                                 // ← ORB: speaking
      statusEl.textContent = '▶ REMINDER SET';
      resumeAfterReply(remReply);
      return;
    }
  }

  // ── MEMORY ──
  if (window.kairosMemory) {
    const memReply = await window.kairosMemory.handleVoice(userSaid);
    if (memReply) {
      addToHistory('user', userSaid);
      isProcessing = true;
      if (mainRec) {
        try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); } catch (e) { }
        mainRec = null;
      }
      mainRecActive = false;
      setOrb('speaking');                                 // ← ORB: speaking
      statusEl.textContent = '▶ MEMORY UPDATED';
      resumeAfterReply(memReply);
      return;
    }
  }

  // ── VOICE COMMANDS ──
  const voiceCmd = checkVoiceCommand(userSaid);
  if (voiceCmd) {
    if (voiceCmd === 'FILE_HANDLED') {
      // Already spoken inside checkVoiceCommand — just log + resume listening.
      addToHistory('user', userSaid);
      sleepTimer = setTimeout(() => { if (!isProcessing) sleepKairos(); }, ACTIVE_TIMEOUT_MS);
      setTimeout(() => { if (isAwake && !isProcessing) startMainListener(); }, 1500);
      return;
    }
    const handled = await handleVoiceCommand(voiceCmd);
    if (handled) {
      addToHistory('user', userSaid);
      sleepTimer = setTimeout(() => { if (!isProcessing) sleepKairos(); }, ACTIVE_TIMEOUT_MS);
      setTimeout(() => { if (isAwake && !isProcessing) startMainListener(); }, 1500);
      return;
    }
  }

  isProcessing = true;
  clearTimeout(sleepTimer);

  if (mainRec) {
    try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); } catch (e) { }
    mainRec = null;
  }
  mainRecActive = false;

  addToHistory('user', userSaid);
  greetingEl.textContent = `"${userSaid}"`;
  setOrb('thinking');                                     // ← ORB: thinking (fetching answer)
  statusEl.textContent = '▶ THINKING...';

  let reply;
  try {
    if (checkDevQuestion(userSaid)) {
      reply = DEV_RESPONSE;
    } else if (window.isWeatherRequest && window.isWeatherRequest(userSaid)) {
      statusEl.textContent = '▶ FETCHING WEATHER...';
      reply = await window.getWeatherReply(userSaid);
    } else if (isScreenRequest(userSaid) || (screenStream && isVisionRequest(userSaid))) {
      setOrb('thinking');
      statusEl.textContent = '▶ ANALYSING SCREEN...';
      if (!screenStream) {
        const opened = await startScreenShare();
        if (!opened) { reply = "Screen sharing was denied or cancelled."; isProcessing = false; resumeAfterReply(reply); return; }
        await new Promise(r => setTimeout(r, 500));
      }
      const imgB64 = captureScreenFrame();
      reply = imgB64 ? await window.askKairosScreen(imgB64, userSaid) : "I couldn't capture your screen.";
    } else if (isVisionRequest(userSaid)) {
      setOrb('thinking');
      statusEl.textContent = '▶ ANALYSING CAMERA...';
      if (!cameraStream) {
        const opened = await openCamera(selectedCamId);
        if (!opened) { reply = "I couldn't access the camera."; isProcessing = false; resumeAfterReply(reply); return; }
        await new Promise(r => setTimeout(r, 800));
      }
      const imgB64 = captureFrame();
      reply = imgB64 ? await window.askKairosVision(imgB64, userSaid) : "I couldn't capture a frame from the camera.";
    } else {
      if (typeof window.askKairosStream === 'function') {
        let streamStarted = false;
        reply = await window.askKairosStream(userSaid, (_delta, full) => {
          if (!streamStarted) {
            streamStarted = true;
            statusEl.textContent = '▶ RESPONDING...';
            setOrb('speaking');
          }
          greetingEl.textContent = full;
        });
      } else {
        reply = await window.askKairos(userSaid);
      }
    }
  } catch (err) {
    console.error('processCommand error:', err);
    setOrb('error');                                      // ← ORB: error
    reply = "I ran into an issue. Please try again.";
  }

  if (generation !== interactionGeneration) return;
  resumeAfterReply(reply);
}

function resumeAfterReply(reply) {
  const generation = interactionGeneration;
  lastSpokenReply = reply.toLowerCase();
  if (hasCodeBlock(reply)) {
    const blocks = extractCodeBlocks(reply);
    if (blocks.length > 0) showCodePanel(blocks);
  }
  setOrb('speaking');                                     // ← ORB: speaking (responding)
  speakAndType(greetingEl, reply, () => {
    if (generation !== interactionGeneration) return;
    addToHistory('kairos', reply);
    isProcessing = false;
    statusEl.textContent = '▶ ACTIVE — SPEAK ANYTIME';
    setOrb('listening');                                  // ← ORB: back to listening
    sleepTimer = setTimeout(() => { if (!isProcessing) sleepKairos(); }, ACTIVE_TIMEOUT_MS);
    setTimeout(() => { if (isAwake && !isProcessing) startMainListener(); }, 1200);
  });
}

// ════════════════════════════════════════
//  SLEEP
// ════════════════════════════════════════
function sleepKairos() {
  isAwake = false; isProcessing = false; mainRecActive = false;
  clearTimeout(sleepTimer); stopKairos();
  setOrb('standby');                                      // ← ORB: standby
  statusEl.textContent = isMicMuted
    ? ((window.KAIROS_UI && window.KAIROS_UI.status_mic_muted) || '▶ MIC MUTED — TAP TO RESUME')
    : ((window.KAIROS_UI && window.KAIROS_UI.status_standby) || '▶ STANDBY — SAY "HEY KAIROS" OR CLAP TWICE');
  if (mainRec) {
    try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); } catch (e) { }
    mainRec = null;
  }
  if (!isMicMuted) setTimeout(buildWakeRec, 500);
}

orb.addEventListener('click', () => {
  if (isMicMuted) { unmuteMic(); return; }
  if (isSpeaking || isProcessing) { window.kairosVoice.interrupt(); return; }
  if (isAwake && !isProcessing) { startMainListener(); }
  else if (!isAwake && !isProcessing) { activateKairos(); }
});

// ════════════════════════════════════════
//  SCREEN SHARE
// ════════════════════════════════════════
let screenStream = null;
let screenVideo = null;

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: 1 }, audio: false
    });
    screenVideo = document.createElement('video');
    screenVideo.muted = true; screenVideo.playsInline = true; screenVideo.autoplay = true;
    screenVideo.srcObject = screenStream;
    await new Promise(r => { screenVideo.onloadedmetadata = r; });
    await screenVideo.play();
    showScreenPreview();
    screenStream.getVideoTracks()[0].addEventListener('ended', stopScreenShare);
    const btn = document.getElementById('screen-btn');
    if (btn) btn.classList.add('active');
    statusEl.textContent = '▶ SCREEN SHARED — SPEAK TO ANALYSE';
    return true;
  } catch (err) { console.warn('Screen share error:', err.name); return false; }
}

// ── SHARED SVG ICONS ──
// Inline rather than emoji: emoji glyphs differ per OS, render as
// full-colour art on iOS/Android, ignore currentColor, and sit
// off-centre in round buttons. These inherit the button's colour.
const ICON_MIC_ON = `
  <svg class="mic-icon mic-on" viewBox="0 0 24 24" fill="none" aria-hidden="true"
       stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M12 2a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
    <path d="M19 10v1a7 7 0 0 1-14 0v-1"/>
    <line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>
  </svg>`;

const ICON_MIC_OFF = `
  <svg class="mic-icon mic-off" viewBox="0 0 24 24" fill="none" aria-hidden="true"
       stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M9 9V5a3 3 0 0 1 5.94-.6"/><path d="M15 11.6V11"/>
    <path d="M19 10v1a7 7 0 0 1-10.7 5.98"/><path d="M5 10v1a7 7 0 0 0 2.05 4.95"/>
    <line x1="12" y1="18" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/>
    <line x1="3" y1="3" x2="21" y2="21"/>
  </svg>`;

const ICON_CAPTURE = `
  <svg class="kx-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"
       stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
    <circle cx="12" cy="13" r="4"/>
  </svg>`;

const ICON_FULLSCREEN = `
  <svg class="kx-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"
       stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M16 21h3a2 2 0 0 0 2-2v-3M8 21H5a2 2 0 0 1-2-2v-3"/>
  </svg>`;

const ICON_CLOSE = `
  <svg class="kx-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"
       stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`;

// Keeps an overlay mic button's icon in sync with the real mute state.
function paintMicButton(btn, muted) {
  if (!btn) return;
  btn.classList.toggle('muted', muted);
  btn.innerHTML = muted ? ICON_MIC_OFF : ICON_MIC_ON;
  const label = muted ? 'Unmute microphone' : 'Mute microphone';
  btn.setAttribute('title', label);
  btn.setAttribute('aria-label', label);
  btn.setAttribute('aria-pressed', muted ? 'true' : 'false');
}

let screenTimerInterval = null;
let screenTimerStart = null;

function showScreenPreview() {
  let preview = document.getElementById('screen-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'screen-preview';
    document.body.appendChild(preview);
  }
  preview.innerHTML = `
    <div class="kx-media-topbar" style="top:24px;">
      <div class="kx-live-pill recording">
        <span class="kx-live-dot"></span>
        <span>SCREEN SHARING ACTIVE</span>
        <span id="screen-timer">00:00</span>
      </div>
      <div class="kx-media-controls">
        <button class="kx-icon-btn" id="screen-mute-btn" aria-pressed="false"></button>
        <button class="kx-icon-btn" id="screen-capture-btn" title="Capture frame"
                aria-label="Capture frame">${ICON_CAPTURE}</button>
        <button class="kx-stop-share-btn" id="screen-stop-btn">Stop Share</button>
      </div>
    </div>
    <div class="kx-screen-frame">
      <video id="screen-thumb" autoplay muted playsinline></video>
    </div>
  `;
  preview.style.display = 'flex';

  paintMicButton(document.getElementById('screen-mute-btn'), isMicMuted);

  document.getElementById('screen-stop-btn').addEventListener('click', stopScreenShare);
  document.getElementById('screen-capture-btn').addEventListener('click', () => {
    const dataUrl = captureScreenFrame();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `kairos-screen-${Date.now()}.jpg`;
    a.click();
  });
  document.getElementById('screen-mute-btn').addEventListener('click', () => {
    // M7: was kairosCore.sleep()/wake() — sleep() ended the whole
    // session and wake() spoke "Yes, how can I help?", so unmuting
    // talked at you. Now it is a real mic mute.
    const muted = window.kairosMic ? window.kairosMic.toggle() : false;
    paintMicButton(document.getElementById('screen-mute-btn'), muted);
  });

  setTimeout(() => {
    const thumb = document.getElementById('screen-thumb');
    if (thumb && screenStream) thumb.srcObject = screenStream;
  }, 100);

  screenTimerStart = Date.now();
  clearInterval(screenTimerInterval);
  screenTimerInterval = setInterval(() => {
    const el = document.getElementById('screen-timer');
    if (el) el.textContent = formatElapsed(screenTimerStart);
  }, 1000);
}

function stopScreenShare() {
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  screenVideo = null;
  const preview = document.getElementById('screen-preview');
  if (preview) { preview.style.display = 'none'; preview.innerHTML = ''; }
  const btn = document.getElementById('screen-btn');
  if (btn) btn.classList.remove('active');
  clearInterval(screenTimerInterval);
  screenTimerInterval = null;
  statusEl.textContent = isAwake ? '▶ ACTIVE — SPEAK ANYTIME' : '▶ STANDBY — SAY "HEY KAIROS" OR CLAP TWICE';
}

function captureScreenFrame() {
  if (!screenVideo || !screenStream) return null;
  const canvas = document.createElement('canvas');
  const maxW = 800, maxH = 450;
  const ratio = Math.min(maxW / screenVideo.videoWidth, maxH / screenVideo.videoHeight);
  canvas.width = Math.round(screenVideo.videoWidth * ratio);
  canvas.height = Math.round(screenVideo.videoHeight * ratio);
  canvas.getContext('2d').drawImage(screenVideo, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.6);
}

async function toggleScreenShare() {
  const allowed = await checkProFeature('screen');
  if (!allowed) return;
  if (screenStream) { stopScreenShare(); }
  else { await startScreenShare(); }
}

// NOTE: screen-btn is wired once, centrally, in index.htm's load listener
// (calls toggleScreenShare()). Binding it again here double-fired the
// toggle per click (screen share started then instantly stopped again).

// ════════════════════════════════════════
//  CAMERA
// ════════════════════════════════════════
let cameraStream = null;
let selectedCamId = null;
let selectedMicId = null;

async function openCamera(deviceId) {
  const camFeed = document.getElementById('cam-feed');
  if (!camFeed) return false;
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  try {
    const constraints = {
      video: deviceId
        ? { deviceId: { exact: deviceId }, width: { ideal: 640 }, height: { ideal: 480 } }
        : { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    };
    cameraStream = await navigator.mediaDevices.getUserMedia(constraints);
    camFeed.muted = true; camFeed.playsInline = true; camFeed.autoplay = true;
    camFeed.srcObject = cameraStream;
    camFeed.style.filter = 'none';
    await new Promise(resolve => { camFeed.onloadedmetadata = resolve; });
    await camFeed.play();
    showCameraOverlay();
    return true;
  } catch (err) { console.error('openCamera error:', err.name); return false; }
}

let camTimerInterval = null;
let camTimerStart = null;
let camMuted = false;

function formatElapsed(startTime) {
  const secs = Math.floor((Date.now() - startTime) / 1000);
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function showCameraOverlay() {
  const camFeed = document.getElementById('cam-feed');
  if (!camFeed) return;

  let bar = document.getElementById('cam-overlay');
  if (bar) bar.remove();
  bar = document.createElement('div');
  bar.id = 'cam-overlay';
  bar.className = 'kx-media-topbar';
  bar.innerHTML = `
    <div class="kx-live-pill recording">
      <span class="kx-live-dot"></span>
      <span>LIVE</span>
      <span id="cam-timer">00:00</span>
    </div>
    <div class="kx-media-controls">
      <button class="kx-icon-btn" id="cam-mute-btn" aria-pressed="false"></button>
      <button class="kx-icon-btn" id="cam-capture-btn" title="Capture frame"
              aria-label="Capture frame">${ICON_CAPTURE}</button>
      <button class="kx-icon-btn" id="cam-fullscreen-btn" title="Fullscreen"
              aria-label="Fullscreen">${ICON_FULLSCREEN}</button>
      <button class="kx-icon-btn danger" id="cam-close-btn" title="Close camera"
              aria-label="Close camera">${ICON_CLOSE}</button>
    </div>
  `;
  document.body.appendChild(bar);

  paintMicButton(document.getElementById('cam-mute-btn'), isMicMuted);

  document.getElementById('cam-close-btn').addEventListener('click', closeCamera);
  document.getElementById('cam-fullscreen-btn').addEventListener('click', () => {
    if (camFeed.requestFullscreen) camFeed.requestFullscreen().catch(() => {});
  });
  document.getElementById('cam-capture-btn').addEventListener('click', () => {
    const dataUrl = captureFrame();
    if (!dataUrl) return;
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `kairos-capture-${Date.now()}.jpg`;
    a.click();
  });
  document.getElementById('cam-mute-btn').addEventListener('click', () => {
    // M7: real mic mute, not session sleep. See screen-mute-btn above.
    camMuted = window.kairosMic ? window.kairosMic.toggle() : !camMuted;
    paintMicButton(document.getElementById('cam-mute-btn'), camMuted);
  });

  camFeed.style.display = 'block';
  const camBtn = document.getElementById('cam-btn');
  if (camBtn) camBtn.classList.add('active');

  camTimerStart = Date.now();
  clearInterval(camTimerInterval);
  camTimerInterval = setInterval(() => {
    const el = document.getElementById('cam-timer');
    if (el) el.textContent = formatElapsed(camTimerStart);
  }, 1000);
}

function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  const camFeed = document.getElementById('cam-feed');
  if (camFeed) { camFeed.srcObject = null; camFeed.style.display = 'none'; }
  const overlay = document.getElementById('cam-overlay');
  if (overlay) overlay.remove();
  const camBtn = document.getElementById('cam-btn');
  if (camBtn) camBtn.classList.remove('active');
  clearInterval(camTimerInterval);
  camTimerInterval = null;
  camMuted = false;
}

async function checkProFeature(feature) {
  try {
    const token = localStorage.getItem('kairos_token') || '';
    const r = await fetch('/api/user/me', { headers: { 'Authorization': `Bearer ${token}` } });
    if (r.status === 401) {
      showNotification('🔒 Please log in to use K.A.I.R.O.S.');
      return false;
    }
    const user = await r.json();
    window.KAIROS_IS_PRO = !!user.is_pro;
    window.KAIROS_PROFILE = user;
    if (user.is_pro) return true;
    const usage = user.feature_usage_today || {};
    const limits = user.feature_limits || {};
    const key = feature === 'cam' ? 'vision' : feature;
    const limit = limits[key];
    const used = usage[key] || 0;
    if (limit == null || used < limit) return true;
    const msg = {
      cam: `You have used ${used} of ${limit} free camera analyses today. Upgrade to Pro for more.`,
      screen: `You have used ${used} of ${limit} free screen analyses today. Upgrade to Pro for more.`,
      mem: `You have used your ${limit}-memory free allowance. Upgrade to Pro for more.`,
      file: ' File sharing limit reached for free plan.',
    }[feature] || 'This free feature allowance is used up. Upgrade to Pro for more.';
    speak(msg);
    showNotification(msg);
    return false;
  } catch { return false; }
}
window.checkProFeature = checkProFeature;
window.showNotification = showNotification;
window.showProNotice = (label) => showNotification(`🔒 ${label} is available for Pro users only. Upgrade to unlock it.`);

function showNotification(text) {
  const existing = document.getElementById('pro-notification');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'pro-notification';
  // Redesign: glass notice from the shared notification family (was a cyan
  // clip-path pill). .kx-notice self-centers at the top and runs its own 4s
  // fade+scale cycle, so the JS still just removes the node at 4s.
  el.className = 'kx-notice';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function toggleCamera() {
  const allowed = await checkProFeature('cam');
  if (!allowed) return;
  if (cameraStream) { closeCamera(); }
  else {
    const ok = await openCamera(selectedCamId || null);
    if (!ok) speak("Camera could not be accessed. Please check your browser permissions.");
  }
}

function captureFrame() {
  const camFeed = document.getElementById('cam-feed');
  if (!camFeed || !cameraStream) return null;
  if (!camFeed.videoWidth || camFeed.readyState < 2) return null;
  const canvas = document.createElement('canvas');
  canvas.width = 480; canvas.height = 360;
  canvas.getContext('2d').drawImage(camFeed, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.45);
}

// NOTE: cam-btn is wired once, centrally, in index.htm's load listener
// (calls toggleCamera()). Binding it again here double-fired the toggle
// per click (camera opened then instantly closed again).

// ════════════════════════════════════════
//  DEVICE SELECTOR
// ════════════════════════════════════════
let availableDevices = { cameras: [], mics: [], speakers: [] };
let savedPrefs = {};
try { savedPrefs = JSON.parse(localStorage.getItem('kairos_devices') || '{}'); } catch (e) { }

async function buildDeviceSelector() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    stream.getTracks().forEach(t => t.stop());
    await refreshDeviceList();
    navigator.mediaDevices.addEventListener('devicechange', async () => {
      await refreshDeviceList();
      renderDeviceSelector();
      autoConnectSavedDevices();
    });
  } catch (err) {
    console.warn('Device setup error:', err);
    try { await refreshDeviceList(); } catch (e) { }
  }
}

async function refreshDeviceList() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  availableDevices.cameras = devices.filter(d => d.kind === 'videoinput');
  availableDevices.mics = devices.filter(d => d.kind === 'audioinput');
  availableDevices.speakers = devices.filter(d => d.kind === 'audiooutput');
  renderDeviceSelector();
}

async function autoConnectSavedDevices() {
  if (savedPrefs.micId) {
    const mic = availableDevices.mics.find(d => d.deviceId === savedPrefs.micId);
    if (mic) selectedMicId = savedPrefs.micId;
  }
  if (savedPrefs.camId) {
    const cam = availableDevices.cameras.find(d => d.deviceId === savedPrefs.camId);
    if (cam) selectedCamId = savedPrefs.camId;
  }
}

function saveDevicePrefs() {
  try { localStorage.setItem('kairos_devices', JSON.stringify(savedPrefs)); } catch (e) { }
}

function renderDeviceSelector() {
  let panel = document.getElementById('device-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'device-panel';
    // Redesign: right-edge glass drawer (.kx-drawer--right) + fade/scale
    // motion (.kx-panel--right), replacing the old right:-100% slide.
    // B3: .kx-drawer width uses min() so a visible edge remains on a 360px phone.
    panel.className = 'kx-drawer kx-drawer--right kx-panel kx-panel--right';
    document.body.appendChild(panel);
  }
  const makeSelect = (label, iconId, items, savedId, onchange) => `
    <div class="kx-field">
      <div class="kx-drawer__eyebrow"><svg class="ic ic--sm" aria-hidden="true"><use href="/icons.svg#${iconId}"/></svg> ${label}</div>
      <select class="glass-input" onchange="${onchange}">
        <option value="">Default / Auto</option>
        ${items.map(d => `<option value="${d.deviceId}" ${d.deviceId === savedId ? 'selected' : ''}>${d.label || d.kind + ' ' + (items.indexOf(d) + 1)}</option>`).join('')}
      </select>
    </div>
  `;
  panel.innerHTML = `
    <div class="kx-drawer__head">
      <span class="kx-drawer__title"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-device"/></svg> CONNECTED DEVICES</span>
      <button class="kx-icon-mini" onclick="toggleDevicePanel()" aria-label="Close device panel"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></button>
    </div>
    <div class="kx-drawer__list kx-scroll">
      <div class="kx-drawer__note">${availableDevices.cameras.length} camera · ${availableDevices.mics.length} mic · ${availableDevices.speakers.length} speaker</div>
      ${makeSelect('CAMERA', 'ic-camera', availableDevices.cameras, savedPrefs.camId, 'selectCamera(this.value)')}
      ${makeSelect('MICROPHONE', 'ic-mic', availableDevices.mics, savedPrefs.micId, 'selectMic(this.value)')}
      ${availableDevices.speakers.length > 0 ? makeSelect('SPEAKER', 'ic-volume', availableDevices.speakers, savedPrefs.speakerId, 'selectSpeaker(this.value)') : ''}
    </div>
    <div class="kx-drawer__foot">
      <div class="kx-drawer__hint">Preferences saved automatically.<br>Connect devices via USB or Bluetooth and they appear here instantly.</div>
    </div>
  `;
}

function toggleDevicePanel() {
  const panel = document.getElementById('device-panel');
  if (!panel) return;
  // open-state now lives on the .open class (was inline style.right === '0px')
  const isOpen = panel.classList.contains('open');
  panel.classList.toggle('open', !isOpen);
  document.body.classList.toggle('kx-panel-open', !isOpen); // dims the orb while open (Brief §5)
  const btn = document.getElementById('device-btn');
  if (btn) btn.classList.toggle('active', !isOpen);
}

function selectCamera(deviceId) {
  selectedCamId = deviceId || null;
  savedPrefs.camId = deviceId || null;
  saveDevicePrefs();
  if (cameraStream) { closeCamera(); setTimeout(() => openCamera(selectedCamId), 300); }
}

function selectMic(deviceId) {
  selectedMicId = deviceId || null;
  savedPrefs.micId = deviceId || null;
  saveDevicePrefs();
  if (isAwake) {
    if (mainRec) { try { mainRec.abort(); } catch (e) { } mainRec = null; mainRecActive = false; }
    setTimeout(() => startMainListener(), 300);
  } else {
    setTimeout(buildWakeRec, 300);
  }
}

function selectSpeaker(deviceId) {
  savedPrefs.speakerId = deviceId || null;
  saveDevicePrefs();
  document.querySelectorAll('audio, video').forEach(el => {
    if (el.setSinkId) el.setSinkId(deviceId).catch(() => { });
  });
}

// NOTE: device-btn is wired once, centrally, in index.htm's load listener
// (calls toggleDevicePanel()). Binding it again here double-fired the
// toggle per click (panel opened then instantly closed again).

// ════════════════════════════════════════
//  HISTORY PANEL — persisted to the DB
//  (was an in-memory array that reset on
//  every reload; now synced with
//  /api/conversations so history survives
//  reloads and users can start a fresh
//  conversation or revisit older ones).
// ════════════════════════════════════════
const historyData = [];
let currentConversationId = localStorage.getItem('kairos_conversation_id') || null;

function conversationAuthHeaders(extra) {
  const token = localStorage.getItem('kairos_token') || '';
  return Object.assign({
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }, extra || {});
}

async function ensureConversation() {
  if (currentConversationId) return currentConversationId;
  try {
    const r = await fetch('/api/conversations', { method: 'POST', headers: conversationAuthHeaders() });
    if (!r.ok) return null;
    const data = await r.json();
    currentConversationId = data.id;
    localStorage.setItem('kairos_conversation_id', currentConversationId);
    return currentConversationId;
  } catch (e) { return null; }
}

async function loadCurrentConversation() {
  if (!localStorage.getItem('kairos_token')) return; // not logged in — nothing to load
  const convId = localStorage.getItem('kairos_conversation_id');
  if (!convId) { await ensureConversation(); return; }
  currentConversationId = convId;
  try {
    const r = await fetch(`/api/conversations/${convId}/messages`, { headers: conversationAuthHeaders() });
    if (r.status === 404) {
      // conversation was deleted elsewhere — start fresh
      localStorage.removeItem('kairos_conversation_id');
      currentConversationId = null;
      await ensureConversation();
      return;
    }
    if (!r.ok) return;
    const data = await r.json();
    window.setKairosHistory && window.setKairosHistory(data.messages || []);
    historyData.length = 0;
    (data.messages || []).forEach(m => historyData.push({
      role: m.role, text: m.content,
      time: new Date(m.created_at).toTimeString().slice(0, 8)
    }));
    renderHistory();
  } catch (e) { /* offline — keep whatever's in memory */ }
}

async function addToHistory(role, text, retrying) {
  historyData.push({ role, text, time: new Date().toTimeString().slice(0, 8) });
  renderHistory();
  const convId = await ensureConversation();
  if (!convId) return;
  try {
    const response = await fetch(`/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: conversationAuthHeaders(),
      body: JSON.stringify({ role, content: text })
    });
    if (response.status === 404 && !retrying) {
      currentConversationId = null;
      localStorage.removeItem('kairos_conversation_id');
      await addToHistory(role, text, true);
    }
  } catch (e) { /* offline — message stays local for this session only */ }
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';
  [...historyData].reverse().forEach(item => {
    const div = document.createElement('div');
    div.className = `hist-item hist-${item.role}`;
    div.innerHTML = `<span class="hist-role">${item.role === 'user' ? '▶ YOU' : '◈ KAIROS'}</span><span class="hist-time">${item.time}</span><p class="hist-text">${escapeHtml(item.text)}</p>`;
    list.appendChild(div);
  });
}

async function startNewConversation() {
  try {
    const r = await fetch('/api/conversations', { method: 'POST', headers: conversationAuthHeaders() });
    if (!r.ok) { showNotification('Could not start a new chat — check your connection.'); return; }
    const data = await r.json();
    currentConversationId = data.id;
    localStorage.setItem('kairos_conversation_id', currentConversationId);
    historyData.length = 0;
    renderHistory();
    document.getElementById('conversation-list').style.display = 'none';
    document.getElementById('history-list').style.display = 'block';
    showNotification('🆕 New conversation started');
  } catch (e) { showNotification('Could not start a new chat — check your connection.'); }
}

async function toggleConversationList() {
  const listEl = document.getElementById('conversation-list');
  const histEl = document.getElementById('history-list');
  const showing = listEl.style.display !== 'none';
  if (showing) {
    listEl.style.display = 'none';
    histEl.style.display = 'block';
    return;
  }
  histEl.style.display = 'none';
  listEl.style.display = 'block';
  listEl.innerHTML = '<div class="kx-convlist__msg">Loading…</div>';
  try {
    const r = await fetch('/api/conversations', { headers: conversationAuthHeaders() });
    if (!r.ok) { listEl.innerHTML = '<div class="kx-convlist__msg">Could not load conversations.</div>'; return; }
    const data = await r.json();
    listEl.innerHTML = '';
    if (!data.conversations.length) {
      listEl.innerHTML = '<div class="kx-convlist__msg">No past conversations yet.</div>';
      return;
    }
    data.conversations.forEach(c => {
      const row = document.createElement('div');
      row.className = 'kx-convlist__row';
      if (String(c.id) === String(currentConversationId)) row.classList.add('is-active');
      row.innerHTML = `<div class="kx-convlist__title">${escapeHtml(c.title || 'New conversation')}</div>
                        <div class="kx-convlist__count">${c.message_count} messages</div>`;
      row.onclick = () => openConversation(c.id);
      listEl.appendChild(row);
    });
  } catch (e) {
    listEl.innerHTML = '<div class="kx-convlist__msg">Could not load conversations.</div>';
  }
}

async function openConversation(convId) {
  try {
    const r = await fetch(`/api/conversations/${convId}/messages`, { headers: conversationAuthHeaders() });
    if (!r.ok) { showNotification('Could not open that conversation.'); return; }
    const data = await r.json();
    window.setKairosHistory && window.setKairosHistory(data.messages || []);
    currentConversationId = convId;
    localStorage.setItem('kairos_conversation_id', convId);
    historyData.length = 0;
    (data.messages || []).forEach(m => historyData.push({
      role: m.role, text: m.content,
      time: new Date(m.created_at).toTimeString().slice(0, 8)
    }));
    renderHistory();
    document.getElementById('conversation-list').style.display = 'none';
    document.getElementById('history-list').style.display = 'block';
  } catch (e) { showNotification('Could not open that conversation.'); }
}

// ════════════════════════════════════════
//  KEYBOARD SHORTCUTS
//  C6: keys come from server config so the admin panel can rebind
//  them. The map below is the offline fallback.
// ════════════════════════════════════════
const FALLBACK_SHORTCUTS = {
  history: 'h', camera: 'c', screen: 's', settings: 'g',
  devices: 'd', reminders: 'r', memory: 'm', files: 'f',
  text_mode: 't', mute_mic: 'x',
};

function shortcutKey(action) {
  const cfg = window.KAIROS_SHORTCUTS || {};
  return String(cfg[action] || FALLBACK_SHORTCUTS[action] || '').toLowerCase();
}

document.addEventListener('keydown', (e) => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;   // don't hijack browser shortcuts

  const key = (e.key || '').toLowerCase();
  if (!key) return;

  if (key === shortcutKey('history'))   toggleHistory();
  if (key === shortcutKey('camera'))    toggleCamera();
  if (key === shortcutKey('screen'))    toggleScreenShare();
  if (key === shortcutKey('settings'))  openKairosSettings();
  if (key === shortcutKey('devices'))   toggleDevicePanel();
  if (key === shortcutKey('reminders')) window.kairosReminders?.togglePanel();
  if (key === shortcutKey('memory'))    window.kairosMemory?.togglePanel();
  if (key === shortcutKey('files'))     window.kairosFiles?.togglePanel();
  if (key === shortcutKey('mute_mic'))  window.kairosMic?.toggle();
});
function toggleHistory() {
  const panel = document.getElementById('history-panel');
  if (panel) panel.classList.toggle('open');
}

// ── CLOCK ──
function startClock() {
  function tick() { const el = document.getElementById('clock'); if (el) el.textContent = new Date().toTimeString().slice(0, 8); }
  tick(); setInterval(tick, 1000);
}
// ════════════════════════════════════════
//  SAFE PUBLIC HOOKS — for camera/screen toolbar mute button
//  (no changes to internal listening logic, just exposure)
// ════════════════════════════════════════
window.kairosCore = {
  sleep: () => { try { sleepKairos(); } catch (e) {} },
  wake:  () => { try { activateKairos(); } catch (e) {} },
  isAwake: () => isAwake,
};
