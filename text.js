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
      /* FULL-SCREEN OVERLAY (Brief §4 row 7).
         Text mode is a focused, edge-to-edge surface — not the old partial
         panel that was pinned to the bottom at 640×520. It now fills the
         viewport and sits at the design system's overlay layer (z-index 60,
         the same as .kx-overlay), above the HUD and side panels, and reveals
         with the shared fade + gentle-scale motion (never a slide). The
         mechanism is unchanged — JS still only toggles the .open class.
         padding-inline is only a small, fluid side gutter (never a fixed
         centered column): the header, messages and input span almost the full
         width — matching the reference — and it shrinks to 16px on phones so
         the surface is truly edge-to-edge, not a narrow modal box. */
      #text-panel {
        position: fixed;
        inset: 0;
        z-index: 60;
        padding-inline: clamp(16px, 4vw, 56px);
        background: rgba(13, 15, 22, 0.92);
        -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(140%);
        backdrop-filter: blur(var(--glass-blur)) saturate(140%);
        display: flex;
        flex-direction: column;
        font-family: var(--font-ui);
        opacity: 0;
        visibility: hidden;
        transform: scale(0.98);
        transform-origin: center;
        transition: opacity var(--dur-overlay) var(--ease-glass),
                    transform var(--dur-overlay) var(--ease-glass),
                    visibility var(--dur-overlay) var(--ease-glass);
        overflow: hidden;
      }
      /* fade + gentle scale (was an off-screen bottom-anchored slide/scale) */
      #text-panel.open {
        opacity: 1;
        visibility: visible;
        transform: scale(1);
      }

      #text-panel-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 14px 18px 12px;
        border-bottom: 1px solid var(--glass-border-soft);
        flex-shrink: 0;
      }
      #text-panel-title {
        font-family: var(--font-display);
        font-size: 0.8rem;
        font-weight: 600;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--text-primary);
        display: flex;
        align-items: center;
        gap: 12px;
      }
      #text-panel-title .ic { color: var(--accent-end); }
      #ai-mute-badge {
        font-family: var(--font-mono);
        font-size: 0.6rem;
        letter-spacing: 0.12em;
        padding: 3px 9px;
        border-radius: var(--glass-radius-pill);
        border: 1px solid rgba(var(--ok-rgb), 0.4);
        color: var(--ok-color);
        background: rgba(var(--ok-rgb), 0.1);
        transition: all var(--dur-fast) var(--ease-out);
      }
      #ai-mute-badge.muted {
        border-color: rgba(var(--danger-rgb), 0.45);
        color: var(--danger-color);
        background: rgba(var(--danger-rgb), 0.1);
      }
      #text-panel-close {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        padding: 0;
        background: none;
        border: none;
        color: var(--text-tertiary);
        cursor: pointer;
        line-height: 1;
        transition: color var(--dur-fast) var(--ease-out);
      }
      #text-panel-close:hover { color: var(--text-primary); }
      #text-panel-close:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--glass-radius-sm); }
      #text-panel-close .ic { width: 16px; height: 16px; }

      #text-mode-hint {
        font-size: 0.66rem;
        letter-spacing: 0.04em;
        color: var(--text-tertiary);
        padding: 6px 18px 8px;
        flex-shrink: 0;
      }

      #text-messages {
        flex: 1;
        overflow-y: auto;
        padding: 12px 18px;
        display: flex;
        flex-direction: column;
        gap: 14px;
        scrollbar-width: thin;
        scrollbar-color: var(--glass-fill-strong) transparent;
      }
      .txt-msg {
        display: flex;
        flex-direction: column;
        gap: 4px;
        animation: msg-in 0.22s var(--ease-out);
      }
      @keyframes msg-in {
        from { opacity:0; transform:translateY(5px); }
        to   { opacity:1; transform:translateY(0);   }
      }
      .txt-msg-role {
        font-size: 0.62rem;
        letter-spacing: 0.16em;
        text-transform: uppercase;
        color: var(--text-tertiary);
      }
      .txt-msg.kairos .txt-msg-role { color: var(--accent-end); }
      .txt-msg-body {
        font-size: 0.92rem;
        line-height: 1.6;
        color: var(--text-secondary);
        border-left: 2px solid var(--glass-border);
        padding-left: 12px;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .txt-msg.kairos .txt-msg-body {
        color: var(--text-primary);
        border-left-color: rgba(var(--accent-end-rgb), 0.4);
      }
      .txt-msg-body.typing::after {
        content: '▋';
        animation: cur-blink 0.7s infinite;
      }
      @keyframes cur-blink { 0%,100%{opacity:1} 50%{opacity:0} }

      /* model-route caption under a reply (was inline green cssText) */
      .txt-route-tag {
        font-size: 0.62rem;
        letter-spacing: 0.12em;
        color: var(--text-tertiary);
        margin-top: 4px;
        padding-left: 12px;
      }

      #pdf-badge {
        display: none;
        margin: 0 18px 6px;
        padding: 7px 12px;
        background: var(--glass-fill-weak);
        border: 1px solid var(--glass-border-soft);
        border-radius: var(--glass-radius-sm);
        font-size: 0.68rem;
        letter-spacing: 0.02em;
        color: var(--text-secondary);
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      #pdf-badge.show { display: flex; }
      #pdf-badge-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 28px; height: 28px; padding: 0;
        background: none; border: none;
        color: var(--text-tertiary); cursor: pointer;
        line-height: 1; transition: color var(--dur-fast) var(--ease-out);
      }
      #pdf-badge-remove:hover { color: var(--danger-color); }
      #pdf-badge-remove .ic { width: 15px; height: 15px; }

      #text-input-row {
        padding: 12px 14px 16px;
        border-top: 1px solid var(--glass-border-soft);
        display: flex;
        gap: 8px;
        align-items: flex-end;
        flex-shrink: 0;
      }
      #pdf-upload-btn {
        flex-shrink: 0;
        width: 40px; height: 40px;
        background: var(--glass-fill-weak);
        border: 1px solid var(--glass-border);
        color: var(--text-secondary);
        border-radius: var(--glass-radius-sm); cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
        position: relative; overflow: hidden;
      }
      #pdf-upload-btn:hover {
        background: var(--glass-fill);
        color: var(--accent-end);
        border-color: var(--glass-border);
      }
      #pdf-upload-btn .ic { width: 17px; height: 17px; }
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
        min-height: 40px; max-height: 120px;
        resize: none;
        background: var(--glass-fill-weak);
        border: 1px solid var(--glass-border);
        border-radius: var(--glass-radius-sm);
        color: var(--text-primary);
        font-family: var(--font-ui);
        font-size: 0.92rem; letter-spacing: 0.01em;
        padding: 10px 46px 10px 14px;
        outline: none; line-height: 1.5;
        box-sizing: border-box;
        transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
        scrollbar-width: thin;
        scrollbar-color: var(--glass-fill-strong) transparent;
      }
      #text-input:focus { border-color: rgba(var(--accent-end-rgb), 0.5); box-shadow: var(--focus-ring); }
      #text-input::placeholder {
        color: var(--text-tertiary); letter-spacing: 0.02em;
      }

      /* mute btn inside textarea — inline SVG, inherits currentColor */
      #text-mute-btn {
        position: absolute; right: 8px; bottom: 8px;
        width: 30px; height: 30px; padding: 0;
        background: none;
        border: 1px solid var(--glass-border);
        border-radius: 50%; cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        color: var(--text-tertiary);
        transition: color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
        flex-shrink: 0; line-height: 1;
        -webkit-tap-highlight-color: transparent;
      }
      #text-mute-btn .spk-icon {
        width: 16px; height: 16px; display: block; pointer-events: none;
      }
      #text-mute-btn:hover {
        background: var(--glass-fill-weak);
        color: var(--accent-end);
      }
      #text-mute-btn:active { transform: scale(0.9); }
      #text-mute-btn:focus-visible {
        outline: none; box-shadow: var(--focus-ring);
      }
      #text-mute-btn.muted {
        border-color: rgba(var(--danger-rgb),0.45);
        color: var(--danger-color);
        background: rgba(var(--danger-rgb),0.08);
      }

      #text-send-btn {
        flex-shrink: 0; height: 40px; padding: 0 16px;
        background: var(--accent-gradient);
        border: none;
        color: var(--text-on-accent);
        font-family: var(--font-display);
        font-size: 0.72rem; font-weight: 600; letter-spacing: 0.12em;
        border-radius: var(--glass-radius-sm); cursor: pointer;
        transition: filter var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
        white-space: nowrap;
        display: inline-flex; align-items: center; gap: 7px;
      }
      #text-send-btn .ic { width: 15px; height: 15px; }
      #text-send-btn:hover { filter: brightness(1.08); }
      #text-send-btn:active { transform: scale(0.97); }
      #text-send-btn:focus-visible { outline: none; box-shadow: var(--focus-ring); }
      #text-send-btn:disabled { opacity: 0.4; cursor: not-allowed; }

      @media (max-width:480px) {
        /* already full-bleed via inset:0 — the old height:80vh override
           would have shrunk it back to a partial panel, so it's gone.
           Just soften the input text size on small screens. */
        #text-input  { font-size: 0.86rem; }
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
          <svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-text"/></svg> TEXT MODE
          <span id="ai-mute-badge">VOICE ON</span>
        </span>
        <button id="text-panel-close" aria-label="Close text mode"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></button>
      </div>

      <div id="text-mode-hint">ENTER TO SEND · SHIFT+ENTER = NEW LINE · SHORTCUTS PAUSED WHILE TYPING</div>

      <div id="pdf-badge">
        <span id="pdf-badge-name">📄 —</span>
        <button id="pdf-badge-remove" aria-label="Remove PDF"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></button>
      </div>

      <div id="text-messages">
        <div class="txt-msg kairos">
          <span class="txt-msg-role">◈ KAIROS</span>
          <div class="txt-msg-body">Text mode active. Type below and I'll respond. Upload a PDF with the 📄 button and ask me anything about it. Tap the speaker icon to silence my voice — replies will show as text only.</div>
        </div>
      </div>

      <div id="text-input-row">
        <button id="pdf-upload-btn" title="Upload PDF" aria-label="Upload PDF">
          <svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-paperclip"/></svg>
          <input type="file" accept=".pdf,application/pdf" id="pdf-file-input" />
        </button>
        <div id="text-input-wrap">
          <textarea id="text-input" placeholder="Ask Kairos anything..." rows="1"></textarea>
          <button id="text-mute-btn" title="Mute AI voice"
                  aria-label="Mute AI voice" aria-pressed="false">${ICON_SPEAKER_ON}</button>
        </div>
        <button id="text-send-btn">SEND <svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-send"/></svg></button>
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

  // Inline SVG instead of 🔊/🔇 — emoji render differently on every OS,
  // ignore currentColor, and sit off-centre in a round button.
  const ICON_SPEAKER_ON = `
    <svg class="spk-icon spk-on" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z"/>
      <path d="M15.5 8.5a5 5 0 0 1 0 7"/>
      <path d="M18.5 5.5a9 9 0 0 1 0 13"/>
    </svg>`;

  const ICON_SPEAKER_OFF = `
    <svg class="spk-icon spk-off" viewBox="0 0 24 24" fill="none" aria-hidden="true"
         stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M11 5 6 9H2v6h4l5 4z"/>
      <line x1="22" y1="9" x2="16" y2="15"/>
      <line x1="16" y1="9" x2="22" y2="15"/>
    </svg>`;

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

      if (btn) {
        btn.innerHTML = ICON_SPEAKER_OFF;
        btn.classList.add('muted');
        btn.setAttribute('aria-pressed', 'true');
        btn.setAttribute('aria-label', 'Unmute AI voice');
        btn.setAttribute('title', 'Unmute AI voice');
      }
      if (badge) { badge.textContent = 'VOICE OFF'; badge.classList.add('muted'); }
    } else {
      if (btn) {
        btn.innerHTML = ICON_SPEAKER_ON;
        btn.classList.remove('muted');
        btn.setAttribute('aria-pressed', 'false');
        btn.setAttribute('aria-label', 'Mute AI voice');
        btn.setAttribute('title', 'Mute AI voice');
      }
      if (badge) { badge.textContent = 'VOICE ON'; badge.classList.remove('muted'); }
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

    // F1/F2 FIX: this used to POST to a hardcoded
    // http://127.0.0.1:5000/upload_pdf with NO Authorization header.
    // The endpoint requires auth, so it returned 401 every single time
    // — PDF upload in text mode has never worked outside localhost, and
    // never worked at all once auth was added. Same-origin + token now.
    const token = localStorage.getItem('kairos_token') || '';

    fetch('/upload_pdf', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData
    })
    .then(async r => {
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const err = new Error(data.error || 'Upload failed');
        err.status = r.status;
        err.payload = data;
        throw err;
      }
      return data;
    })
    .then(data => {
      if (data.text && data.text.length > 0) {
        pdfContext = `[ATTACHED PDF: "${file.name}"]\n${data.text}\n\n`;
        const pages = data.pages || 0;
        // F3 FIX: this read data.chars, which the backend never returns
        // — users literally saw "undefined chars". Derive it instead.
        const chars = data.text.length;
        if (badgeName) badgeName.textContent = `📄 ${file.name} (${pages}p)`;
        appendMsg(
          'kairos',
          `Read "${file.name}" — ${pages} page${pages !== 1 ? 's' : ''}, ` +
          `${chars.toLocaleString()} characters. Ask me anything about it.`
        );
      } else {
        pdfContext = `[User attached PDF: "${file.name}" — no extractable text found.]`;
        if (badgeName) badgeName.textContent = `📄 ${file.name} (image PDF)`;
        appendMsg('kairos', `Got "${file.name}" but it appears to be image-based — I can't extract the text directly.`);
      }
    })
    .catch(err => {
      pdfContext = '';
      badge.classList.remove('show');
      if (err.status === 401) {
        appendMsg('kairos', 'Please log in again to upload files.');
      } else if (err.status === 403 && err.payload && err.payload.pro_required) {
        appendMsg('kairos', err.payload.error || 'File sharing limit reached — upgrade to Pro.');
      } else {
        appendMsg('kairos', err.message || 'PDF upload failed. Please try again.');
      }
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
      let reply;

      // A3: stream when available so text appears within ~1s instead of
      // after the whole completion. Falls back automatically.
      if (typeof window.askKairosStream === 'function') {
        const body = typingEl.querySelector('.txt-msg-body');
        let started = false;

        reply = await window.askKairosStream(
          fullMessage,
          (_delta, full) => {
            if (!started) {
              started = true;
              if (body) body.classList.remove('typing');
            }
            if (body) {
              body.textContent = full;
              const container = document.getElementById('text-messages');
              if (container) container.scrollTop = container.scrollHeight;
            }
          },
          { raw: userText }
        );

        typingEl.remove();
        appendMsg('kairos', reply);
      } else {
        reply = await window.askKairos(fullMessage, { raw: userText });
        typingEl.remove();
        appendMsg('kairos', reply);
      }

      // Show which model answered — makes the smart router visible.
      if (window.KAIROS_LAST_ROUTE) {
        const r = window.KAIROS_LAST_ROUTE;
        const tag = document.createElement('div');
        tag.className = 'txt-route-tag';
        tag.textContent = `◈ ${r.label || r.intent || ''} · ${r.model || ''}`.trim();
        const msgs = document.getElementById('text-messages');
        if (msgs && msgs.lastElementChild) msgs.lastElementChild.appendChild(tag);
      }

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
      console.error('text.js send error:', err);
      typingEl.remove();
      appendMsg('kairos', 'Connection error. Please check your network and try again.');
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
  // NOTE: txt-btn is wired once, centrally, in index.htm's load listener
  // (calls window.kairosTextMode.togglePanel()). This function used to bind
  // it again here — and was itself called twice (once in init(), once more
  // on window 'load') — so a single click toggled the panel 2-3 times in a
  // row and it looked like the button did nothing.
  function addHudButton() { /* no-op — kept so existing calls below don't error */ }

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