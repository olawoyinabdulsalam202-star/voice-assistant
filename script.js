// ════════════════════════════════════════
//  script.js  —  KAIROS CORE  v14
//  New:
//  • Orb state engine wired (setOrbState)
//    standby / listening / thinking / speaking / error
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

// ── THREE.JS BACKGROUND ──
const renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('bg-canvas'), antialias: true, alpha: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.z = 5;

const COUNT = 2000;
const pos = new Float32Array(COUNT * 3);
for (let i = 0; i < COUNT; i++) {
  const i3 = i * 3, r = 2 + Math.random() * 5;
  const t = Math.random() * Math.PI * 2, p = Math.random() * Math.PI;
  pos[i3] = r * Math.sin(p) * Math.cos(t);
  pos[i3 + 1] = r * Math.sin(p) * Math.sin(t);
  pos[i3 + 2] = r * Math.cos(p);
}
const geo = new THREE.BufferGeometry();
geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x00d4ff, size: 0.022, transparent: true, opacity: 0.55 }));
scene.add(pts);

const clk = new THREE.Clock();
(function loop() {
  requestAnimationFrame(loop);
  const e = clk.getElapsedTime();
  pts.rotation.y = e * 0.07;
  pts.rotation.x = Math.sin(e * 0.18) * 0.07;
  renderer.render(scene, camera);
})();

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ── REVEAL INTERFACE ──
function revealInterface() {
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
    setOrb('standby');
    autoGreet();
    startWakeWordListener();
    startClapDetection();
    startClock();
    await buildDeviceSelector();
    autoConnectSavedDevices();
  }, 1800);
}

// ── VIDEO LOGIC ──
const vid = document.getElementById('intro-video');
const hasVideo = vid && vid.getAttribute('src') && vid.getAttribute('src') !== '';
if (hasVideo) {
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
  const msg = `Good ${t}, Mr. Abdulsalam. Say "Hey Kairos" or clap twice to activate me.`;
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

function hasCodeBlock(text) { return text.includes('```'); }

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
    panel.style.cssText = `
      position:fixed; bottom:80px; left:50%; transform:translateX(-50%);
      width:min(700px,90vw); max-height:320px; overflow-y:auto;
      background:rgba(0,5,20,0.97); border:1px solid rgba(0,212,255,0.25);
      border-radius:4px; z-index:20; padding:0;
      font-family:'Courier New',monospace; font-size:0.78rem;
      scrollbar-width:thin; scrollbar-color:rgba(0,212,255,0.2) transparent;
      box-shadow:0 0 30px rgba(0,212,255,0.1);
    `;
    document.body.appendChild(panel);
  }
  const BTN = `background:none;border:1px solid rgba(0,212,255,0.2);color:rgba(0,212,255,0.5);font-size:0.5rem;letter-spacing:0.1em;padding:2px 8px;cursor:pointer;font-family:inherit;margin-left:6px;`;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 16px;border-bottom:1px solid rgba(0,212,255,0.1);font-size:0.55rem;letter-spacing:0.2em;color:rgba(0,212,255,0.4);">
      ◈ CODE OUTPUT
      <button onclick="document.getElementById('code-panel').style.display='none'" style="${BTN}">✕ CLOSE</button>
    </div>
    ${blocks.map(b => `
      <div style="border-bottom:1px solid rgba(0,212,255,0.08);padding:12px 16px;">
        <div style="font-size:0.52rem;letter-spacing:0.2em;color:rgba(0,212,255,0.35);margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;">
          <span>${b.lang.toUpperCase() || 'CODE'}</span>
          <button onclick="navigator.clipboard.writeText(this.closest('div').nextElementSibling.textContent).then(()=>{this.textContent='✓ COPIED';setTimeout(()=>this.textContent='COPY',1500)})" style="${BTN}">COPY</button>
        </div>
        <pre style="margin:0;white-space:pre-wrap;color:rgba(0,212,255,0.85);line-height:1.6;">${escapeHtml(b.code)}</pre>
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

function speakAndType(el, text, onDone) {
  if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
  window.speechSynthesis.cancel();
  isSpeaking = false;
  el.textContent = '';
  const spokenText = cleanForSpeech(text);
  const displayText = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/#{1,6}\s/g, '').replace(/`/g, '').trim();
  let doneFired = false;
  function fireDone() {
    if (doneFired) return; doneFired = true;
    isSpeaking = false; el.textContent = displayText;
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
  window.speechSynthesis.cancel();
  isSpeaking = false;
  if (typingInterval) { clearInterval(typingInterval); typingInterval = null; }
}

function speak(text, onDone) {
  if (!('speechSynthesis' in window)) { if (onDone) onDone(); return; }
  window.speechSynthesis.cancel();
  isSpeaking = false;
  let doneFired = false;
  function fireDone() { if (doneFired) return; doneFired = true; isSpeaking = false; if (onDone) onDone(); }
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

// ════════════════════════════════════════
//  DEVELOPER CREDITS
// ════════════════════════════════════════
const DEV_KEYWORDS = ['who made you', 'who built you', 'who developed you', 'who created you', 'who is your developer', 'who designed you', 'who programmed you', 'who are you built by', 'your creator', 'your developer', 'who owns you', 'who is your owner', 'who is your maker', 'who is your founder'];
const DEV_RESPONSE = `I was built by Mr Alameen — a web developer and AI developer based in Lagos, Nigeria, operating under the brand Elite Dev. He specialises in premium frontend and backend experiences, AI-powered interfaces, and JavaScript and Python development.`;
function checkDevQuestion(text) { return DEV_KEYWORDS.some(kw => text.toLowerCase().includes(kw)); }

// ════════════════════════════════════════
//  VOICE COMMAND DETECTION
// ════════════════════════════════════════
function checkVoiceCommand(text) {
  const lower = text.toLowerCase();
  const fileReply = window.kairosFiles?.handleVoice(text);
  if (fileReply) { speak(fileReply); return; }
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
    case 'CAMERA_ON':
      if (!cameraStream) {
        const ok = await openCamera(selectedCamId);
        speak(ok ? "Camera activated, Mr. Abdulsalam." : "I couldn't access the camera.");
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
let sleepTimer = null;
let wakeDebounce = false;
let mainRecActive = false;
let restartPending = false;

const ACTIVE_TIMEOUT_MS = 60000;

// ════════════════════════════════════════
//  WAKE WORDS
// ════════════════════════════════════════
const WAKE_WORDS = [
  'kairos', 'hey kairos', 'wake up kairos',
  'rise kairos', 'kairos awaken', 'engage kairos',
  'kairos online', 'activate kairos',
];

function isWakeWord(transcript) {
  const lower = transcript.toLowerCase().trim();
  return WAKE_WORDS.some(w => lower.includes(w));
}

// ════════════════════════════════════════
//  CLAP DETECTION
// ════════════════════════════════════════
async function startClapDetection() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(stream);
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);

    const buffer = new Uint8Array(analyser.frequencyBinCount);
    let lastClap = 0;
    let clapCount = 0;
    let clapCooldown = false;

    setInterval(() => {
      if (isAwake || clapCooldown) return;
      analyser.getByteFrequencyData(buffer);
      const volume = buffer.reduce((a, b) => a + b) / buffer.length;

      if (volume > 75) {
        const now = Date.now();
        if (now - lastClap < 800) {
          clapCount++;
          if (clapCount >= 2) {
            clapCount = 0;
            clapCooldown = true;
            setTimeout(() => { clapCooldown = false; }, 2000);
            // Visual feedback — brief scale pulse
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
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  try { if (wakeRec) { wakeRec.onend = null; wakeRec.onerror = null; wakeRec.onresult = null; wakeRec.abort(); } } catch (e) { }

  wakeRec = new SR();
  wakeRec.continuous = true; wakeRec.interimResults = true; wakeRec.lang = 'en-US';

  wakeRec.onresult = (e) => {
    if (isAwake) return;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (isWakeWord(t) && !wakeDebounce && !isProcessing) {
        wakeDebounce = true;
        setTimeout(() => { wakeDebounce = false; }, 2500);
        activateKairos(); return;
      }
    }
  };

  wakeRec.onend = () => { if (!isAwake) setTimeout(buildWakeRec, 400); };
  wakeRec.onerror = (e) => { if (e.error !== 'no-speech') console.warn('Wake:', e.error); if (!isAwake) setTimeout(buildWakeRec, 800); };
  try { wakeRec.start(); } catch (e) { setTimeout(buildWakeRec, 800); }
}

// ════════════════════════════════════════
//  ACTIVATE KAIROS
// ════════════════════════════════════════
function activateKairos() {
  isAwake = true;
  clearTimeout(sleepTimer);
  try { wakeRec.onend = null; wakeRec.abort(); } catch (e) { }

  setOrb('listening');                                    // ← ORB: listening
  statusEl.textContent = '▶ LISTENING...';
  greetingEl.textContent = '';
  speak("Yes, how can I help?", () => { startMainListener(); });
}

// ════════════════════════════════════════
//  MAIN LISTENER
// ════════════════════════════════════════
function startMainListener() {
  if (!isAwake || isProcessing) return;
  if (mainRecActive || restartPending) return;
  restartPending = true;

  setTimeout(() => {
    restartPending = false;
    if (!isAwake || isProcessing) return;

    if (mainRec) {
      try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); } catch (e) { }
      mainRec = null;
    }

    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    mainRec = new SR();
    mainRec.lang = 'en-US'; mainRec.continuous = true; mainRec.interimResults = true; mainRec.maxAlternatives = 1;

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
      if (display) greetingEl.textContent = `"${display}"`;
      if (isSpeaking && display.length > 1) { stopKairos(); statusEl.textContent = '▶ LISTENING...'; }
      if (silenceTimer) clearTimeout(silenceTimer);
      if (!isProcessing) {
        silenceTimer = setTimeout(() => {
          const command = finalText.trim();
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

  const userSaid = sanitizeInput(rawInput);
  if (!userSaid) return;

  // ── REMINDERS ──
  if (window.kairosReminders) {
    const remReply = window.kairosReminders.handleVoice(userSaid);
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
      reply = await window.askKairos(userSaid);
    }
  } catch (err) {
    console.error('processCommand error:', err);
    setOrb('error');                                      // ← ORB: error
    reply = "I ran into an issue. Please try again.";
  }

  resumeAfterReply(reply);
}

function resumeAfterReply(reply) {
  if (hasCodeBlock(reply)) {
    const blocks = extractCodeBlocks(reply);
    if (blocks.length > 0) showCodePanel(blocks);
  }
  setOrb('speaking');                                     // ← ORB: speaking (responding)
  speakAndType(greetingEl, reply, () => {
    addToHistory('kairos', reply);
    isProcessing = false;
    statusEl.textContent = '▶ ACTIVE — SPEAK ANYTIME';
    setOrb('listening');                                  // ← ORB: back to listening
    sleepTimer = setTimeout(() => { if (!isProcessing) sleepKairos(); }, ACTIVE_TIMEOUT_MS);
    setTimeout(() => { if (isAwake && !isProcessing) startMainListener(); }, 600);
  });
}

// ════════════════════════════════════════
//  SLEEP
// ════════════════════════════════════════
function sleepKairos() {
  isAwake = false; isProcessing = false; mainRecActive = false;
  clearTimeout(sleepTimer); stopKairos();
  setOrb('standby');                                      // ← ORB: standby
  statusEl.textContent = '▶ STANDBY — SAY "HEY KAIROS" OR CLAP TWICE';
  if (mainRec) {
    try { mainRec.onend = null; mainRec.onerror = null; mainRec.onresult = null; mainRec.abort(); } catch (e) { }
    mainRec = null;
  }
  setTimeout(buildWakeRec, 500);
}

orb.addEventListener('click', () => {
  if (isSpeaking) { stopKairos(); if (isAwake && !isProcessing) setTimeout(() => startMainListener(), 300); return; }
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

function showScreenPreview() {
  let preview = document.getElementById('screen-preview');
  if (!preview) {
    preview = document.createElement('div');
    preview.id = 'screen-preview';
    preview.style.cssText = `position:fixed;bottom:80px;right:28px;width:220px;background:rgba(0,5,20,0.95);border:1px solid rgba(0,212,255,0.25);border-radius:4px;z-index:15;overflow:hidden;`;
    document.body.appendChild(preview);
  }
  preview.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;padding:5px 10px;font-family:'Share Tech Mono',monospace;font-size:0.52rem;letter-spacing:0.15em;color:rgba(0,212,255,0.5);background:rgba(0,212,255,0.05);">
      ◈ SCREEN SHARE ACTIVE
      <button onclick="stopScreenShare()" style="background:none;border:none;color:rgba(0,212,255,0.5);cursor:pointer;font-size:0.9rem;padding:0 2px;">✕</button>
    </div>
    <video id="screen-thumb" autoplay muted playsinline style="width:100%;display:block;max-height:130px;object-fit:contain;background:#000;"></video>
  `;
  setTimeout(() => {
    const thumb = document.getElementById('screen-thumb');
    if (thumb && screenStream) thumb.srcObject = screenStream;
  }, 100);
  preview.style.display = 'block';
}

function stopScreenShare() {
  if (screenStream) { screenStream.getTracks().forEach(t => t.stop()); screenStream = null; }
  screenVideo = null;
  const preview = document.getElementById('screen-preview');
  if (preview) preview.style.display = 'none';
  const btn = document.getElementById('screen-btn');
  if (btn) btn.classList.remove('active');
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
  if (screenStream) { stopScreenShare(); }
  else { await startScreenShare(); }
}

function wireScreenBtn() {
  const btn = document.getElementById('screen-btn');
  if (btn && !btn._wired) { btn.addEventListener('click', toggleScreenShare); btn._wired = true; }
}
wireScreenBtn();
document.addEventListener('DOMContentLoaded', wireScreenBtn);

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

function showCameraOverlay() {
  const camFeed = document.getElementById('cam-feed');
  if (!camFeed) return;
  let overlay = document.getElementById('cam-overlay');
  if (!overlay) { overlay = document.createElement('div'); overlay.id = 'cam-overlay'; document.body.appendChild(overlay); }
  function positionOverlay() {
    const rect = camFeed.getBoundingClientRect();
    overlay.style.cssText = `position:fixed;top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;z-index:16;font-family:'Share Tech Mono',monospace;display:flex;justify-content:space-between;align-items:center;padding:4px 8px;background:rgba(0,0,0,0.5);font-size:0.5rem;letter-spacing:0.15em;color:rgba(0,212,255,0.5);`;
    overlay.innerHTML = `<span>◈ CAM</span><button onclick="closeCamera()" style="background:none;border:none;color:rgba(0,212,255,0.6);cursor:pointer;font-size:0.85rem;padding:0;">✕</button>`;
  }
  camFeed.style.display = 'block';
  const camBtn = document.getElementById('cam-btn');
  if (camBtn) camBtn.classList.add('active');
  setTimeout(positionOverlay, 100);
  window.addEventListener('resize', positionOverlay);
}

function closeCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  const camFeed = document.getElementById('cam-feed');
  if (camFeed) { camFeed.srcObject = null; camFeed.style.display = 'none'; }
  const overlay = document.getElementById('cam-overlay');
  if (overlay) overlay.remove();
  const camBtn = document.getElementById('cam-btn');
  if (camBtn) camBtn.classList.remove('active');
}

async function toggleCamera() {
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

function wireCamBtn() {
  const camBtn = document.getElementById('cam-btn');
  if (camBtn && !camBtn._wired) { camBtn.addEventListener('click', toggleCamera); camBtn._wired = true; }
}
wireCamBtn();
document.addEventListener('DOMContentLoaded', wireCamBtn);

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
    panel.style.cssText = `position:fixed;top:50%;right:-300px;transform:translateY(-50%);width:280px;background:rgba(0,5,20,0.97);border:1px solid rgba(0,212,255,0.15);border-radius:4px;z-index:30;padding:16px;transition:right 0.3s ease;font-family:'Share Tech Mono',monospace;font-size:0.62rem;color:rgba(0,212,255,0.7);`;
    document.body.appendChild(panel);
  }
  const selStyle = `width:100%;background:rgba(0,212,255,0.05);border:1px solid rgba(0,212,255,0.15);color:rgba(0,212,255,0.7);font-family:'Share Tech Mono',monospace;font-size:0.58rem;padding:4px;letter-spacing:0.05em;outline:none;margin-top:4px;`;
  const makeSelect = (label, items, savedId, onchange) => `
    <div style="margin-bottom:14px;">
      <div style="font-size:0.5rem;letter-spacing:0.2em;color:rgba(0,212,255,0.35);">${label}</div>
      <select onchange="${onchange}" style="${selStyle}">
        <option value="">Default / Auto</option>
        ${items.map(d => `<option value="${d.deviceId}" ${d.deviceId === savedId ? 'selected' : ''}>${d.label || d.kind + ' ' + (items.indexOf(d) + 1)}</option>`).join('')}
      </select>
    </div>
  `;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;font-size:0.55rem;letter-spacing:0.2em;color:rgba(0,212,255,0.5);">
      ◈ CONNECTED DEVICES
      <button onclick="toggleDevicePanel()" style="background:none;border:none;color:rgba(0,212,255,0.4);cursor:pointer;font-size:0.85rem;">✕</button>
    </div>
    <div style="font-size:0.48rem;letter-spacing:0.15em;color:rgba(0,212,255,0.25);margin-bottom:12px;">
      ${availableDevices.cameras.length} camera · ${availableDevices.mics.length} mic · ${availableDevices.speakers.length} speaker
    </div>
    ${makeSelect('📷 CAMERA', availableDevices.cameras, savedPrefs.camId, 'selectCamera(this.value)')}
    ${makeSelect('🎤 MICROPHONE', availableDevices.mics, savedPrefs.micId, 'selectMic(this.value)')}
    ${availableDevices.speakers.length > 0 ? makeSelect('🔊 SPEAKER', availableDevices.speakers, savedPrefs.speakerId, 'selectSpeaker(this.value)') : ''}
    <div style="font-size:0.45rem;letter-spacing:0.1em;color:rgba(0,212,255,0.2);margin-top:8px;">
      Preferences saved automatically.<br>Connect devices via USB or Bluetooth<br>and they appear here instantly.
    </div>
  `;
}

function toggleDevicePanel() {
  const panel = document.getElementById('device-panel');
  if (!panel) return;
  const isOpen = panel.style.right === '0px';
  panel.style.right = isOpen ? '-300px' : '0px';
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

function wireDeviceBtn() {
  const btn = document.getElementById('device-btn');
  if (btn && !btn._wired) { btn.addEventListener('click', toggleDevicePanel); btn._wired = true; }
}
wireDeviceBtn();
document.addEventListener('DOMContentLoaded', wireDeviceBtn);

// ════════════════════════════════════════
//  HISTORY PANEL
// ════════════════════════════════════════
const historyData = [];
function addToHistory(role, text) {
  historyData.push({ role, text, time: new Date().toTimeString().slice(0, 8) });
  renderHistory();
}
function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  list.innerHTML = '';
  [...historyData].reverse().forEach(item => {
    const div = document.createElement('div');
    div.className = `hist-item hist-${item.role}`;
    div.innerHTML = `<span class="hist-role">${item.role === 'user' ? '▶ YOU' : '◈ KAIROS'}</span><span class="hist-time">${item.time}</span><p class="hist-text">${item.text}</p>`;
    list.appendChild(div);
  });
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'h' || e.key === 'H') toggleHistory();
  if (e.key === 'c' || e.key === 'C') toggleCamera();
  if (e.key === 's' || e.key === 'S') toggleScreenShare();
  if (e.key === 'd' || e.key === 'D') toggleDevicePanel();
  if (e.key === 'r' || e.key === 'R') window.kairosReminders?.togglePanel();
  if (e.key === 'm' || e.key === 'M') window.kairosMemory?.togglePanel();
  if (e.key === 'f' || e.key === 'F') window.kairosFiles?.togglePanel();
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