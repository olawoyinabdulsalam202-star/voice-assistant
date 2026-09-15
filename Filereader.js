// ════════════════════════════════════════
//  Filereader.js  —  KAIROS FILE READER  v3
//  FIXED: PDF extraction, context injection,
//         DOCX support, TXT support
// ════════════════════════════════════════

(function () {

  // ── CDN ──
  // Using a stable PDF.js version that works reliably in browser
  const PDF_JS_URL    = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
  const PDF_WORKER    = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
  const MAMMOTH_URL   = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

  // ── STATE ──
  let activeFile   = null;  // { name, text, charCount }
  let panelOpen    = false;
  let pdfReady     = false;
  let mammothReady = false;

  // ── LOAD SCRIPT HELPER ──
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) { resolve(); return; }
      const s = document.createElement('script');
      const timeout = setTimeout(() => {
        s.remove();
        reject(new Error(`Timed out loading document reader`));
      }, 15000);
      s.src = src;
      s.onload  = () => { clearTimeout(timeout); resolve(); };
      s.onerror = () => { clearTimeout(timeout); reject(new Error(`Failed to load document reader`)); };
      document.head.appendChild(s);
    });
  }

  // ════════════════════════════════════════
  //  PDF EXTRACTION — FIXED
  // ════════════════════════════════════════
  async function ensurePdf() {
    if (pdfReady) return;
    await loadScript(PDF_JS_URL);
    // must set worker AFTER script loads
    if (window.pdfjsLib) {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
      pdfReady = true;
    } else {
      throw new Error('PDF.js failed to load');
    }
  }

  async function extractPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    let pdf;
    try {
      const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
      pdf = await loadingTask.promise;
    } catch (workerError) {
      // Weak or filtered networks often block pdf.worker.min.js. PDF.js can
      // still extract locally on its main thread, so keep uploads usable.
      const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer, disableWorker: true });
      pdf = await loadingTask.promise;
    }
    const totalPages  = pdf.numPages;
    const pageTexts   = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page        = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText    = textContent.items
        .map(item => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (pageText) pageTexts.push(pageText);
    }

    return pageTexts.join('\n\n');
  }

  // ════════════════════════════════════════
  //  DOCX EXTRACTION
  // ════════════════════════════════════════
  async function ensureMammoth() {
    if (mammothReady) return;
    await loadScript(MAMMOTH_URL);
    if (!window.mammoth) throw new Error('Mammoth.js failed to load');
    mammothReady = true;
  }

  async function extractDocx(file) {
    const arrayBuffer = await file.arrayBuffer();
    const result      = await window.mammoth.extractRawText({ arrayBuffer });
    return result.value;
  }

  // ════════════════════════════════════════
  //  TXT EXTRACTION
  // ════════════════════════════════════════
  async function extractTxt(file) {
    return await file.text();
  }

  // ════════════════════════════════════════
  //  MAIN FILE PROCESSOR
  // ════════════════════════════════════════
  async function processFile(file) {
    if (!file) return;

    const name = file.name;
    const ext  = name.split('.').pop().toLowerCase();

    if (!['pdf', 'doc', 'docx', 'txt'].includes(ext)) {
      setStatus('⚠ UNSUPPORTED FORMAT — USE PDF, DOCX, OR TXT');
      return;
    }

    // Free plan: 1 file share total. Pro: unlimited. Checked + consumed server-side.
    try {
      const token = localStorage.getItem('kairos_token') || '';
      const gate = await fetch('/api/file/use', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (gate.status === 403) {
        window.showNotification && window.showNotification('📄 File sharing limit reached — upgrade to Pro for unlimited files.');
        if (typeof window.speak === 'function') window.speak("You've used your free file share. Upgrade to Pro for unlimited file sharing.");
        return;
      }
      if (gate.status === 401) {
        window.showNotification && window.showNotification('🔒 Please log in to use K.A.I.R.O.S.');
        return;
      }
    } catch (e) {
      // if the gate check itself fails, don't block the user — fail open on network errors
    }

    setStatus('⏳ READING FILE...');
    updateStatusBar('▶ READING FILE...');

    // close panel while loading
    if (panelOpen) togglePanel();

    try {
      let text = '';

      if (ext === 'txt') {
        text = await extractTxt(file);

      } else if (ext === 'pdf') {
        setStatus('⏳ LOADING PDF ENGINE...');
        await ensurePdf();
        setStatus('⏳ EXTRACTING PDF TEXT...');
        text = await extractPdf(file);

      } else if (ext === 'doc' || ext === 'docx') {
        setStatus('⏳ LOADING DOCX ENGINE...');
        await ensureMammoth();
        setStatus('⏳ EXTRACTING DOCX TEXT...');
        text = await extractDocx(file);
      }

      // validate
      if (!text || text.trim().length < 5) {
        setStatus('⚠ NO TEXT FOUND — FILE MAY BE SCANNED/IMAGE-ONLY');
        updateStatusBar('▶ FILE READ FAILED');
        if (typeof window.speak === 'function')
          window.speak("I couldn't extract text from that file. It may be a scanned image.");
        return;
      }

      // A8 FIX: this used to cap at 40 000 chars while the backend's
      // sanitize_input truncated the whole message at 2 000 — so roughly
      // 95% of every document was assembled, sent, and thrown away. The
      // cap now matches the server's MAX_FILE_CONTEXT_CHARS, fetched
      // from /api/config/public with a safe default.
      const limit    = (window.KAIROS_LIMITS && window.KAIROS_LIMITS.max_file_context_chars) || 24000;
      const trimmed  = text.trim().slice(0, limit);
      const wasTruncated = text.trim().length > limit;
      activeFile = {
        name,
        text:      trimmed,
        charCount: trimmed.length,
        truncated: wasTruncated,
        pages:     ext === 'pdf' ? trimmed.split('\n\n').length : null,
      };

      setStatus('✓ FILE READY');
      updateActiveBar();
      updateStatusBar('▶ FILE LOADED — ASK ME ANYTHING ABOUT IT');
      showFileBadge(name);

      const sizeStr = Math.ceil(trimmed.length / 1000) + 'k chars';
      if (typeof window.speak === 'function')
        window.speak(`Got it. I've read ${name} — ${sizeStr} extracted. What would you like to know?`);
      if (typeof window.addToHistory === 'function')
        window.addToHistory('kairos', `◈ FILE LOADED: ${name} (${sizeStr})`);

    } catch (err) {
      console.error('Filereader.js error:', err);
      setStatus(`⚠ ERROR: ${err.message || 'Could not read file'}`);
      updateStatusBar('▶ FILE READ ERROR');
      if (typeof window.speak === 'function')
        window.speak("I ran into an error reading that file. Please check the console for details.");
    }
  }

  // ════════════════════════════════════════
  //  CONTEXT INJECTOR
  //  Called by askKairos patch below
  // ════════════════════════════════════════
  function getFileContext() {
    if (!activeFile) return null;
    const note = activeFile.truncated
      ? ' — truncated to fit the context window'
      : '';
    return (
      `[DOCUMENT LOADED — "${activeFile.name}" (${Math.ceil(activeFile.charCount/1000)}k chars${note})]\n` +
      `${activeFile.text}\n` +
      `[END DOCUMENT — answer the user's question based on this document]`
    );
  }

  // ════════════════════════════════════════
  //  PATCH askKairos — inject file context
  //
  //  A7 FIX: this used to call original(augmented), so brain.js stored
  //  the ENTIRE document in conversation history and prepended it again
  //  next turn. By turn four the same document was in the payload four
  //  times — quadratic growth in latency and token cost. Raw and
  //  augmented are now separate.
  // ════════════════════════════════════════
  function wrap(fnName) {
    const original = window[fnName];
    if (!original || original._filePatched) return false;

    if (fnName === 'askKairosStream') {
      window[fnName] = async function (userMessage, onDelta, opts) {
        const options = opts || {};
        const base    = options.augmented || userMessage;
        const ctx     = getFileContext();
        return original(userMessage, onDelta, {
          ...options,
          raw: options.raw || userMessage,
          augmented: ctx ? `${ctx}\n\nUser question: ${base}` : base,
        });
      };
    } else {
      window[fnName] = async function (userMessage, opts) {
        const options = opts || {};
        const base    = options.augmented || userMessage;
        const ctx     = getFileContext();
        return original(userMessage, {
          ...options,
          raw: options.raw || userMessage,
          augmented: ctx ? `${ctx}\n\nUser question: ${base}` : base,
        });
      };
    }

    window[fnName]._filePatched = true;
    return true;
  }

  function patchAskKairos() {
    const done = wrap('askKairos');
    wrap('askKairosStream');
    if (!done && !(window.askKairos && window.askKairos._filePatched)) {
      setTimeout(patchAskKairos, 300);
    }
  }

  // ════════════════════════════════════════
  //  PANEL UI
  // ════════════════════════════════════════
  function ensurePanel() {
    if (document.getElementById('file-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'file-panel';
    // Redesign: glass bottom-sheet (.kx-drawer--bottom) + fade/scale motion
    // (.kx-panel--bottom) instead of the old bottom:-500px off-screen slide.
    panel.className = 'kx-drawer kx-drawer--bottom kx-panel kx-panel--bottom';

    panel.innerHTML = `
      <!-- HEADER -->
      <div class="kx-drawer__head">
        <span class="kx-drawer__title"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-file"/></svg> FILE READER</span>
        <div class="kx-field-row">
          <button id="file-add-btn" class="kx-icon-mini kx-file-add" title="Browse for file" aria-label="Browse for file">
            <svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-plus"/></svg>
            <input id="file-input-btn" type="file" accept=".pdf,.doc,.docx,.txt" />
          </button>
          <button class="kx-icon-mini" onclick="window.kairosFiles.togglePanel()" aria-label="Close file reader"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></button>
        </div>
      </div>

      <div class="kx-filepanel__body">
        <!-- DROP ZONE -->
        <div id="file-dropzone" class="kx-dropzone">
          <div class="kx-dropzone__icon"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-file-text"/></svg></div>
          <div class="kx-dropzone__main">DROP PDF, DOCX, OR TXT HERE</div>
          <div class="kx-dropzone__sub">or tap <b>+</b> above to browse</div>
          <input id="file-input" type="file" accept=".pdf,.doc,.docx,.txt" />
        </div>

        <!-- STATUS -->
        <div id="file-status" class="kx-file-status">NO FILE LOADED</div>

        <!-- ACTIVE FILE BAR (JS toggles display:flex/none, so it starts hidden) -->
        <div id="file-active-bar" class="kx-item" style="display:none;align-items:center;">
          <div class="kx-item__main">
            <div id="file-active-name" class="kx-item__value"></div>
            <div id="file-active-meta" class="kx-item__meta"></div>
          </div>
          <button onclick="window.kairosFiles.clearFile()" class="kx-icon-mini kx-icon-mini--danger" aria-label="Clear file"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-trash"/></svg></button>
        </div>
      </div>

      <!-- HINTS -->
      <div class="kx-drawer__foot">
        <div class="kx-drawer__hint">
          DRAG FILE ANYWHERE ON SCREEN  ·  PRESS <b>F</b>  ·  LONG-PRESS ORB<br>
          SAY "LOAD FILE" OR "CLEAR FILE"
        </div>
      </div>
    `;

    document.body.appendChild(panel);
    wirePanelEvents();
  }

  // ════════════════════════════════════════
  //  WIRE PANEL EVENTS
  // ════════════════════════════════════════
  function wirePanelEvents() {
    // drop zone drag/drop
    const zone = document.getElementById('file-dropzone');
    if (zone) {
      zone.addEventListener('dragover', e => {
        e.preventDefault();
        zone.classList.add('is-drag');
      });
      zone.addEventListener('dragleave', () => {
        zone.classList.remove('is-drag');
      });
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.classList.remove('is-drag');
        const file = e.dataTransfer?.files?.[0];
        if (file) processFile(file);
      });
    }

    // browse input inside drop zone
    const inputZone = document.getElementById('file-input');
    if (inputZone) {
      inputZone.addEventListener('change', () => {
        const file = inputZone.files?.[0];
        if (file) processFile(file);
        inputZone.value = '';
      });
    }

    // + button input
    const inputBtn = document.getElementById('file-input-btn');
    if (inputBtn) {
      inputBtn.addEventListener('change', () => {
        const file = inputBtn.files?.[0];
        if (file) processFile(file);
        inputBtn.value = '';
      });
    }
  }

  // ════════════════════════════════════════
  //  FULL-PAGE DROP OVERLAY
  // ════════════════════════════════════════
  function wirePageDrop() {
    let overlay = document.getElementById('file-page-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'file-page-overlay';
      // appearance via .kx-drop-overlay; JS below toggles display/pointer-events
      overlay.className = 'kx-drop-overlay';
      overlay.innerHTML = `
        <div class="kx-drop-overlay__icon"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-file-text"/></svg></div>
        <div class="kx-drop-overlay__title">DROP FILE TO LOAD</div>
        <div class="kx-drop-overlay__sub">PDF · DOCX · TXT</div>
      `;
      document.body.appendChild(overlay);
    }

    let dragCounter = 0;

    document.addEventListener('dragenter', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragCounter++;
      if (dragCounter === 1) {
        overlay.style.display     = 'flex';
        overlay.style.pointerEvents = 'all';
      }
    });

    document.addEventListener('dragleave', () => {
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) {
        overlay.style.display     = 'none';
        overlay.style.pointerEvents = 'none';
      }
    });

    document.addEventListener('dragover', e => { e.preventDefault(); });

    document.addEventListener('drop', e => {
      e.preventDefault();
      dragCounter = 0;
      overlay.style.display     = 'none';
      overlay.style.pointerEvents = 'none';
      const file = e.dataTransfer?.files?.[0];
      if (file) processFile(file);
    });
  }

  // ════════════════════════════════════════
  //  UI HELPERS
  // ════════════════════════════════════════
  function setStatus(msg) {
    const el = document.getElementById('file-status');
    if (el) el.textContent = msg || 'NO FILE LOADED';
  }

  function updateStatusBar(msg) {
    const el = document.getElementById('status');
    if (el) el.textContent = msg;
  }

  function updateActiveBar() {
    const bar  = document.getElementById('file-active-bar');
    const name = document.getElementById('file-active-name');
    const meta = document.getElementById('file-active-meta');
    if (!bar) return;
    if (activeFile) {
      bar.style.display = 'flex';
      if (name) name.textContent = activeFile.name;
      if (meta) meta.textContent = `${Math.ceil(activeFile.charCount / 1000)}K CHARS EXTRACTED`;
    } else {
      bar.style.display = 'none';
    }
  }

  function showFileBadge(name) {
    let badge = document.getElementById('file-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'file-badge';
      badge.className = 'kx-file-badge';
      badge.addEventListener('click', () => window.kairosFiles.togglePanel());
      document.body.appendChild(badge);
    }
    const short = name.length > 28 ? name.slice(0, 25) + '…' : name;
    badge.innerHTML = `
      <span class="kx-file-badge__icon"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-file-text"/></svg></span>
      <span class="kx-file-badge__name">${short}</span>
      <span class="kx-file-badge__close" onclick="event.stopPropagation();window.kairosFiles.clearFile()" role="button" aria-label="Clear file"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></span>
    `;
    badge.style.display = 'flex';
    const btn = document.getElementById('file-btn');
    if (btn) btn.classList.add('active');
  }

  function hideFileBadge() {
    const badge = document.getElementById('file-badge');
    if (badge) badge.style.display = 'none';
    const btn = document.getElementById('file-btn');
    if (btn) btn.classList.remove('active');
  }

  // ════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════
  function clearFile() {
    activeFile = null;
    updateActiveBar();
    setStatus('NO FILE LOADED');
    hideFileBadge();
    if (typeof window.speak === 'function') window.speak('File cleared.');
  }

  function togglePanel() {
    ensurePanel();
    const panel = document.getElementById('file-panel');
    if (!panel) return;
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);                  // fade+scale (was bottom:0 / -500px slide)
    document.body.classList.toggle('kx-panel-open', panelOpen); // dims the orb while open (Brief §5)
    const btn = document.getElementById('file-btn');
    if (btn) btn.classList.toggle('active', panelOpen || !!activeFile);
    if (panelOpen) { updateActiveBar(); wirePanelEvents(); }
  }

  function handleVoice(text) {
    const lower = text.toLowerCase();
    if (['open file','load file','upload file','load document','open document',
         'read file','read document','file reader','open reader','attach file']
        .some(p => lower.includes(p))) {
      togglePanel();
      return "Opening file reader. Drop a PDF, Word doc, or text file anywhere on screen — or tap + to browse.";
    }
    if (['clear file','remove file','close file','forget file','unload file']
        .some(p => lower.includes(p))) {
      if (activeFile) { clearFile(); return 'File cleared.'; }
      return 'No file is currently loaded.';
    }
    return null;
  }

  // ════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════
  function wireOrbLongPress() {
    const orb = document.getElementById('orb');
    if (!orb || orb._fileLongPress) return;
    orb._fileLongPress = true;
    let t = null;
    orb.addEventListener('mousedown',   () => { t = setTimeout(togglePanel, 600); });
    orb.addEventListener('mouseup',     () => clearTimeout(t));
    orb.addEventListener('mouseleave',  () => clearTimeout(t));
    orb.addEventListener('touchstart',  () => { t = setTimeout(togglePanel, 600); }, { passive: true });
    orb.addEventListener('touchend',    () => clearTimeout(t), { passive: true });
    orb.addEventListener('touchcancel', () => clearTimeout(t), { passive: true });
  }

  function init() {
    ensurePanel();
    wirePageDrop();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        wireOrbLongPress();
      });
    } else {
      wireOrbLongPress();
    }
    // patch askKairos after all other scripts settle
    setTimeout(patchAskKairos, 1000);
  }

  window.kairosFiles = { togglePanel, clearFile, handleVoice, getFileContext };

  init();

})();
