// ════════════════════════════════════════
//  textmode.js  —  KAIROS TEXT INTERFACE
//  v2
//
//  FIXES:
//  • Mute btn = silences AI voice output
//    (speechSynthesis.cancel + blocks future speak)
//  • Keyboard shortcuts blocked while typing
//  • PDF extraction wired to /upload_pdf endpoint
// ════════════════════════════════════════

(function () {

  let panelOpen = false;
  let aiMuted   = false;
  let isTyping  = false;
  let pdfContext = '';

  // ════════════════════════════════════════
  //  INJECT STYLES
  // ════════════════════════════════════════
  function injectStyles() {
    if (document.getElementById('textmode-styles')) return;
    const s = document.createElement('style');
    s.id = 'textmode-styles';
    s.textContent = `
      #text-panel {
        position: fixed;
        left: 50%;
        bottom: -680px;
        transform: translateX(-50%);
        width: min(640px, 96vw);
        height: 520px;
        z-index: 55;
        background: rgba(0, 2, 15, 0.98);
        border: 1px solid rgba(0, 212, 255, 0.18);
        border-bottom: none;
        border-radius: 8px 8px 0 0;
        display: flex;
        flex-direction: column;
        font-family: 'Share Tech Mono', monospace;
        transition: bottom 0.42s cubic-bezier(0.22, 1, 0.36, 1);
        overflow: hidden;
      }
      #text-panel.open { bottom: 0; }

      #text-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 12px 18px 10px;
        border-bottom: 1px solid rgba(0, 212, 255, 0.08);
        flex-shrink: 0;
      }
      #text-panel-title {
        font-family: 'Orbitron', monospace;
        font-size: 0.6rem;
        letter-spacing: 0.3em;
        color: var(--cyan, #00d4ff);
        display: flex;
        align-items: center;
        gap: 12px;
      }
      #ai-mute-badge {
        font-family: 'Share Tech Mono', monospace;
        font-size: 0.42rem;
        letter-spacing: 0.15em;
        padding: 2px 8px;
        border-radius: 2px;
        border: 1px solid rgba(0, 255, 140, 0.3);
        color: rgba(0, 255, 140, 0.6);
        background: rgba(0, 255, 140, 0.05);
        transition: all 0.25s;
      }
      #ai-mute-badge.muted {
        border-color: rgba(255, 68, 68, 0.4);
        color: rgba(255, 68, 68, 0.8);
        background: rgba(255, 68, 68, 0.06);
      }
      #text-panel-close {
        background: none;
        border: none;
        color: rgba(0, 212, 255, 0.35);
        font-size: 1rem;
        cursor: pointer;
        transition: color 0.2s;
        line-height: 1;
      }
      #text-panel-close:hover { color: var(--cyan, #00d4ff); }

      #text-mode-hint {
        font-size: 0.42rem;
        letter-spacing: 0.15em;
        color: rgba(0, 212, 255, 0.18);
        padding: 4px 18px 8px;
        flex-shrink: 0;
      }

      #text-messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px 18px;
        display: flex;
        flex-direction: column;
        gap: 12px;
        scrollbar-width: thin;
        scrollbar-color: rgba(0, 212, 255, 0.15) transparent;
      }
      .txt-msg {
        display: flex;
        flex-direction: column;
        gap: 3px;
        animation: msg-in 0.22s ease;
      }
      @keyframes msg-in {
        from { opacity:0; transform:translateY(5px); }
        to   { opacity:1; transform:translateY(0);   }
      }
      .txt-msg-role {
        font-size: 0.44rem;
        letter-spacing: 0.2em;
        color: rgba(0, 212, 255, 0.35);
      }
      .txt-msg.kairos .txt-msg-role { color: rgba(0, 255, 140, 0.45); }
      .txt-msg-body {
        font-size: 0.72rem;
        line-height: 1.65;
        color: rgba(0, 212, 255, 0.78);
        border-left: 2px solid rgba(0, 212, 255, 0.12);
        padding-left: 10px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .txt-msg.kairos .txt-msg-body {
        color: rgba(0, 255, 140, 0.8);
        border-left-color: rgba(0, 255, 140, 0.15);
      }
      .txt-msg-body.typing::after {
        content: '▋';
        animation: cur-blink 0.7s infinite;
      }
      @keyframes cur-blink { 0%,100%{opacity:1} 50%{opacity:0} }

      #pdf-badge {
        display: none;
        margin: 0 18px 6px;
        padding: 5px 10px;
        background: rgba(0, 212, 255, 0.05);
        border: 1px solid rgba(0, 212, 255, 0.15);
        border-radius: 3px;
        font-size: 0.46rem;
        letter-spacing: 0.15em;
        color: rgba(0, 212, 255, 0.5);
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      #pdf-badge.show { display: flex; }
      #pdf-badge-remove {
        background: none; border: none;
        color: rgba(0,212,255,0.3); cursor: pointer;
        font-size: 0.9rem; line-height: 1; transition: color 0.2s;
      }
      #pdf-badge-remove:hover { color: #ff4444; }

      #text-input-row {
        padding: 10px 14px 14px;
        border-top: 1px solid rgba(0, 212, 255, 0.08);
        display: flex;
        gap: 8px;
        align-items: flex-end;
        flex-shrink: 0;
      }
      #pdf-upload-btn {
        flex-shrink: 0;
        width: 36px; height: 36px;
        background: rgba(0,212,255,0.05);
        border: 1px solid rgba(0,212,255,0.18);
        color: rgba(0,212,255,0.45);
        border-radius: 3px; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 0.85rem; transition: all 0.2s;
        position: relative; overflow: hidden;
      }
      #pdf-upload-btn:hover {
        background: rgba(0,212,255,0.1);
        color: var(--cyan,#00d4ff);
        border-color: rgba(0,212,255,0.35);
      }
      #pdf-upload-btn input[type=file] {
        position: absolute; inset: 0;
        opacity: 0; cursor: pointer; font-size: 0;
      }
      #text-input-wrap {
        flex: 1; position: relative;
        display: flex; align-items: flex-end;
      }
      #text-input {
        width: 100%;
        min-height: 36px; max-height: 120px;
        resize: none;
        background: rgba(0,212,255,0.04);
        border: 1px solid rgba(0,212,255,0.18);
        border-radius: 3px;
        color: rgba(0,212,255,0.85);
        font-family: 'Share Tech Mono', monospace;
        font-size: 0.68rem; letter-spacing: 0.05em;
        padding: 9px 44px 9px 12px;
        outline: none; line-height: 1.5;
        box-sizing: border-box; transition: border-color 0.2s;
        scrollbar-width: thin;
        scrollbar-color: rgba(0,212,255,0.1) transparent;
      }
      #text-input:focus { border-color: rgba(0,212,255,0.4); }
      #text-input::placeholder {
        color: rgba(0,212,255,0.2); letter-spacing: 0.08em;
      }

      /* 🔊 mute btn inside textarea */
      #text-mute-btn {
        position: absolute; right: 8px; bottom: 7px;
        width: 26px; height: 26px;
        background: none;
        border: 1px solid rgba(0,212,255,0.18);
        border-radius: 50%; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        font-size: 0.7rem; color: rgba(0,212,255,0.45);
        transition: all 0.2s; flex-shrink: 0; line-height: 1;
      }
      #text-mute-btn:hover {
        background: rgba(0,212,255,0.08);
        color: var(--cyan,#00d4ff);
      }
      #text-mute-btn.muted {
        border-color: rgba(255,68,68,0.45);
        color: #ff4444;
        background: rgba(255,68,68,0.07);
      }

      #text-send-btn {
        flex-shrink: 0; height: 36px; padding: 0 14px;
        background: rgba(0,212,255,0.08);
        border: 1px solid rgba(0,212,255,0.25);
        color: rgba(0,212,255,0.7);
        font-family: 'Share Tech Mono', monospace;
        font-size: 0.55rem; letter-spacing: 0.15em;
        border-radius: 3px; cursor: pointer;
        transition: all 0.2s; white-space: nowrap;
      }
      #text-send-btn:hover {
        background: rgba(0,212,255,0.15);
        color: var(--cyan,#00d4ff);
        border-color: rgba(0,212,255,0.5);
      }
      #text-send-btn:disabled { opacity: 0.35; cursor: not-allowed; }

      @media (max-width:480px) {
        #text-panel { height: 80vh; }
        #text-input  { font-size: 0.62rem; }
      }
    `;
    document.head.appendChild(s);
  }

  // ════════════════════════════════════════
  //  BUILD PANEL
  // ════════════════════════════════════════
  function buildPanel() {
    if (document.getElementById('text-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'text-panel';
    panel.innerHTML = `
      <div id="text-panel-header">
        <span id="text-panel-title">
          ⌨ TEXT MODE
          <span id="ai-mute-badge">🔊 VOICE ON</span>
        </span>
        <button id="text-panel-close">✕</button>
      </div>

      <div id="text-mode-hint">ENTER TO SEND · SHIFT+ENTER = NEW LINE · SHORTCUTS PAUSED WHILE TYPING</div>

      <div id="pdf-badge">
        <span id="pdf-badge-name">📄 —</span>
        <button id="pdf-badge-remove">✕</button>
      </div>

      <div id="text-messages">
        <div class="txt-msg kairos">
          <span class="txt-msg-role">◈ KAIROS</span>
          <div class="txt-msg-body">Text mode active. Type below and I'll respond. Upload a PDF with the 📄 button and ask me anything about it. Tap 🔊 to silence my voice — replies will show as text only.</div>
        </div>
      </div>

      <div id="text-input-row">
        <button id="pdf-upload-btn" title="Upload PDF">
          📄
          <input type="file" accept=".pdf,application/pdf" id="pdf-file-input" />
        </button>
        <div id="text-input-wrap">
          <textarea id="text-input" placeholder="Ask Kairos anything..." rows="1"></textarea>
          <button id="text-mute-btn" title="Mute AI voice">🔊</button>
        </div>
        <button id="text-send-btn">SEND ▶</button>
      </div>
    `;
    document.body.appendChild(panel);
    wirePanel();
  }

  // ════════════════════════════════════════
  //  WIRE EVENTS
  // ════════════════════════════════════════
  function wirePanel() {
    document.getElementById('text-panel-close')
      .addEventListener('click', togglePanel);

    document.getElementById('text-send-btn')
      .addEventListener('click', sendMessage);

    const textarea = document.getElementById('text-input');

    textarea.addEventListener('keydown', e => {
      // Enter = send
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      // Block ALL keystrokes from reaching document-level shortcut listeners
      e.stopPropagation();
    });
    textarea.addEventListener('keyup',    e => e.stopPropagation());
    textarea.addEventListener('keypress', e => e.stopPropagation());

    // Auto-resize
    textarea.addEventListener('input', () => {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
    });

    document.getElementById('text-mute-btn')
      .addEventListener('click', toggleAiMute);

    document.getElementById('pdf-badge-remove')
      .addEventListener('click', removePdf);

    document.getElementById('pdf-file-input')
      .addEventListener('change', handlePdfUpload);
  }

  // ════════════════════════════════════════
  //  AI VOICE MUTE
  //  Cancels current speech + blocks future
  //  speak() / speakAndType() calls
  // ════════════════════════════════════════
  function toggleAiMute() {
    aiMuted = !aiMuted;
    window._kairosAiMuted = aiMuted;   // read by script.js speak wrappers

    const btn   = document.getElementById('text-mute-btn');
    const badge = document.getElementById('ai-mute-badge');

    if (aiMuted) {
      // Kill any speech currently playing
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();

      btn.textContent = '🔇';
      btn.classList.add('muted');
      if (badge) { badge.textContent = '🔇 VOICE OFF'; badge.classList.add('muted'); }
    } else {
      btn.textContent = '🔊';
      btn.classList.remove('muted');
      if (badge) { badge.textContent = '🔊 VOICE ON'; badge.classList.remove('muted'); }
    }
  }

  // ════════════════════════════════════════
  //  PDF UPLOAD  →  /upload_pdf
  // ════════════════════════════════════════
  function handlePdfUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const badge     = document.getElementById('pdf-badge');
    const badgeName = document.getElementById('pdf-badge-name');

    badge.classList.add('show');
    if (badgeName) badgeName.textContent = `⏳ Reading ${file.name}...`;
    appendMsg('kairos', `Reading "${file.name}"...`);

    const formData = new FormData();
    formData.append('file', file);

    fetch('http://127.0.0.1:5000/upload_pdf', {
      method: 'POST',
      body: formData
    })
    .then(r => { if (!r.ok) throw new Error('Upload failed'); return r.json(); })
    .then(data => {
      if (data.text && data.text.length > 0) {
        pdfContext = `[ATTACHED PDF: "${file.name}"]\n${data.text.slice(0, 4000)}\n\n`;
        if (badgeName) badgeName.textContent = `📄 ${file.name} (${data.pages}p)`;
        appendMsg('kairos', `Read "${file.name}" — ${data.pages} page${data.pages !== 1 ? 's' : ''}, ${data.chars} chars. Ask me anything about it.`);
      } else {
        pdfContext = `[User attached PDF: "${file.name}" — no extractable text found.]`;
        if (badgeName) badgeName.textContent = `📄 ${file.name} (image PDF)`;
        appendMsg('kairos', `Got "${file.name}" but it appears to be image-based — I can't extract the text directly.`);
      }
    })
    .catch(() => {
      pdfContext = '';
      badge.classList.remove('show');
      appendMsg('kairos', 'PDF upload failed. Check that backend.py is running with the /upload_pdf endpoint.');
    });

    e.target.value = '';
  }

  function removePdf() {
    pdfContext = '';
    document.getElementById('pdf-badge').classList.remove('show');
    appendMsg('kairos', 'PDF removed.');
  }

  // ════════════════════════════════════════
  //  SEND MESSAGE
  // ════════════════════════════════════════
  async function sendMessage() {
    const textarea = document.getElementById('text-input');
    const sendBtn  = document.getElementById('text-send-btn');
    const raw = (textarea.value || '').trim();
    if (!raw || isTyping) return;

    const userText = raw;
    textarea.value = '';
    textarea.style.height = 'auto';

    appendMsg('user', userText);

    isTyping = true;
    sendBtn.disabled = true;
    const typingEl = appendMsg('kairos', '', true);

    if (typeof window.setOrbState === 'function') window.setOrbState('thinking');

    const fullMessage = pdfContext ? `${pdfContext}User question: ${userText}` : userText;

    try {
      const reply = await window.askKairos(fullMessage);
      typingEl.remove();
      appendMsg('kairos', reply);

      if (!aiMuted) {
        if (typeof window.setOrbState === 'function') window.setOrbState('speaking');
        const greetingEl = document.getElementById('greeting');
        if (greetingEl && typeof window.speakAndType === 'function') {
          window.speakAndType(greetingEl, reply, () => {
            if (typeof window.setOrbState === 'function') window.setOrbState('standby');
          });
        }
      } else {
        if (typeof window.setOrbState === 'function') window.setOrbState('standby');
      }

      if (typeof window.addToHistory === 'function') {
        window.addToHistory('user', userText);
        window.addToHistory('kairos', reply);
      }

    } catch (err) {
      typingEl.remove();
      appendMsg('kairos', 'Connection error. Make sure backend.py is running.');
      if (typeof window.setOrbState === 'function') window.setOrbState('error');
    }

    isTyping = false;
    sendBtn.disabled = false;
    textarea.focus();
  }

  // ════════════════════════════════════════
  //  APPEND MESSAGE
  // ════════════════════════════════════════
  function appendMsg(role, text, isTypingIndicator = false) {
    const container = document.getElementById('text-messages');
    if (!container) return null;

    const wrap = document.createElement('div');
    wrap.className = `txt-msg ${role === 'kairos' ? 'kairos' : 'user'}`;

    const roleLabel = document.createElement('span');
    roleLabel.className = 'txt-msg-role';
    roleLabel.textContent = role === 'kairos' ? '◈ KAIROS' : '▶ YOU';

    const body = document.createElement('div');
    body.className = 'txt-msg-body' + (isTypingIndicator ? ' typing' : '');
    body.textContent = isTypingIndicator ? 'Processing' : text;

    wrap.appendChild(roleLabel);
    wrap.appendChild(body);
    container.appendChild(wrap);
    container.scrollTop = container.scrollHeight;
    return wrap;
  }

  // ════════════════════════════════════════
  //  TOGGLE PANEL
  // ════════════════════════════════════════
  function togglePanel() {
    buildPanel();
    const panel = document.getElementById('text-panel');
    if (!panel) return;
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);
    const btn = document.getElementById('txt-btn');
    if (btn) btn.classList.toggle('active', panelOpen);
    if (panelOpen) {
      setTimeout(() => { document.getElementById('text-input')?.focus(); }, 440);
    }
  }

  // ════════════════════════════════════════
  //  WIRE HUD BUTTON
  // ════════════════════════════════════════
  function addHudButton() {
    const btn = document.getElementById('txt-btn');
    if (btn && !btn._txtWired) {
      btn.addEventListener('click', togglePanel);
      btn._txtWired = true;
    }
  }

  window.kairosTextMode = { togglePanel, appendMsg, isMuted: () => aiMuted };

  // T shortcut — only outside input fields
  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === 't' || e.key === 'T') togglePanel();
  });

  function init() {
    injectStyles();
    buildPanel();
    addHudButton();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  window.addEventListener('load', () => setTimeout(addHudButton, 500));

})();