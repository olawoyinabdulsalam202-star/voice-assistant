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
      s.src = src;
      s.onload  = resolve;
      s.onerror = () => reject(new Error(`Failed to load: ${src}`));
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
    const loadingTask = window.pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf         = await loadingTask.promise;
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

      // store — cap at 40k chars to avoid token overflow
      const trimmed  = text.trim().slice(0, 40000);
      activeFile = {
        name,
        text:      trimmed,
        charCount: trimmed.length,
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
    return (
      `[DOCUMENT LOADED — "${activeFile.name}" (${Math.ceil(activeFile.charCount/1000)}k chars)]\n` +
      `${activeFile.text}\n` +
      `[END DOCUMENT — answer the user's question based on this document]`
    );
  }

  // ════════════════════════════════════════
  //  PATCH askKairos — inject file context
  //  Runs after a short delay to ensure
  //  brain.js + memory.js + multilang.js
  //  are all already patched first
  // ════════════════════════════════════════
  function patchAskKairos() {
    if (!window.askKairos) { setTimeout(patchAskKairos, 300); return; }
    if (window.askKairos._filePatched) return;

    const original = window.askKairos;

    window.askKairos = async function (userMessage, ...rest) {
      const ctx = getFileContext();
      const augmented = ctx
        ? `${ctx}\n\nUser question: ${userMessage}`
        : userMessage;
      return original(augmented, ...rest);
    };

    window.askKairos._filePatched = true;
  }

  // ════════════════════════════════════════
  //  PANEL UI
  // ════════════════════════════════════════
  function ensurePanel() {
    if (document.getElementById('file-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'file-panel';
    panel.style.cssText = `
      position:fixed;left:50%;bottom:-500px;
      transform:translateX(-50%);
      width:min(500px,96vw);z-index:60;
      background:rgba(0,2,15,0.97);
      border:1px solid rgba(0,212,255,0.18);
      border-bottom:none;border-radius:6px 6px 0 0;
      transition:bottom 0.4s cubic-bezier(0.22,1,0.36,1);
      font-family:'Share Tech Mono',monospace;overflow:hidden;
    `;

    panel.innerHTML = `
      <!-- HEADER -->
      <div style="display:flex;justify-content:space-between;align-items:center;
                  padding:16px 20px 12px;border-bottom:1px solid rgba(0,212,255,0.1);">
        <span style="font-family:'Orbitron',monospace;font-size:0.65rem;
                     letter-spacing:0.3em;color:var(--cyan,#00d4ff);">◈ FILE READER</span>
        <div style="display:flex;align-items:center;gap:10px;">
          <button id="file-add-btn" title="Browse for file"
                  style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.25);
                         color:var(--cyan,#00d4ff);font-family:'Orbitron',monospace;
                         font-size:1rem;line-height:1;width:28px;height:28px;
                         cursor:pointer;border-radius:3px;
                         display:flex;align-items:center;justify-content:center;
                         position:relative;overflow:hidden;">
            +
            <input id="file-input-btn" type="file" accept=".pdf,.doc,.docx,.txt"
                   style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;" />
          </button>
          <button onclick="window.kairosFiles.togglePanel()"
                  style="background:none;border:none;color:rgba(0,212,255,0.4);
                         cursor:pointer;font-size:1rem;">✕</button>
        </div>
      </div>

      <!-- DROP ZONE -->
      <div id="file-dropzone"
           style="margin:16px 20px 0;border:1px dashed rgba(0,212,255,0.25);
                  border-radius:4px;padding:32px 20px;text-align:center;
                  cursor:pointer;transition:border-color 0.2s,background 0.2s;
                  position:relative;">
        <div style="font-size:2rem;margin-bottom:10px;opacity:0.5;pointer-events:none;">📄</div>
        <div style="font-size:0.6rem;letter-spacing:0.2em;color:rgba(0,212,255,0.6);pointer-events:none;">
          DROP PDF, DOCX, OR TXT HERE
        </div>
        <div style="font-size:0.47rem;letter-spacing:0.15em;color:rgba(0,212,255,0.25);
                    margin-top:6px;pointer-events:none;">
          or tap <span style="color:rgba(0,212,255,0.5);">+</span> above to browse
        </div>
        <input id="file-input" type="file" accept=".pdf,.doc,.docx,.txt"
               style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;" />
      </div>

      <!-- STATUS -->
      <div id="file-status"
           style="margin:10px 20px 6px;font-size:0.54rem;letter-spacing:0.12em;
                  color:rgba(0,212,255,0.4);min-height:20px;text-align:center;">
        NO FILE LOADED
      </div>

      <!-- ACTIVE FILE BAR -->
      <div id="file-active-bar"
           style="display:none;margin:0 20px 14px;background:rgba(0,212,255,0.06);
                  border:1px solid rgba(0,212,255,0.15);border-radius:3px;
                  padding:10px 14px;justify-content:space-between;align-items:center;">
        <div style="min-width:0;flex:1;">
          <div id="file-active-name"
               style="font-size:0.62rem;color:var(--cyan,#00d4ff);
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
          <div id="file-active-meta"
               style="font-size:0.45rem;letter-spacing:0.12em;
                      color:rgba(0,212,255,0.3);margin-top:3px;"></div>
        </div>
        <button onclick="window.kairosFiles.clearFile()"
                style="background:none;border:1px solid rgba(0,212,255,0.15);
                       color:rgba(0,212,255,0.4);font-size:0.58rem;cursor:pointer;
                       padding:4px 10px;margin-left:12px;border-radius:2px;flex-shrink:0;">
          ✕ CLEAR
        </button>
      </div>

      <!-- HINTS -->
      <div style="padding:8px 20px 14px;font-size:0.42rem;letter-spacing:0.12em;
                  color:rgba(0,212,255,0.18);line-height:2.2;text-align:center;
                  border-top:1px solid rgba(0,212,255,0.06);">
        DRAG FILE ANYWHERE ON SCREEN  ·  PRESS <span style="color:rgba(0,212,255,0.4);">F</span>  ·  LONG-PRESS ORB<br>
        SAY "LOAD FILE" OR "CLEAR FILE"
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
        zone.style.borderColor = 'rgba(0,212,255,0.7)';
        zone.style.background  = 'rgba(0,212,255,0.05)';
      });
      zone.addEventListener('dragleave', () => {
        zone.style.borderColor = 'rgba(0,212,255,0.25)';
        zone.style.background  = '';
      });
      zone.addEventListener('drop', e => {
        e.preventDefault();
        zone.style.borderColor = 'rgba(0,212,255,0.25)';
        zone.style.background  = '';
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
      overlay.style.cssText = `
        position:fixed;inset:0;z-index:9999;
        display:none;
        border:3px dashed rgba(255,213,128,0.6);
        background:rgba(0,5,25,0.75);
        align-items:center;justify-content:center;
        flex-direction:column;gap:16px;
        pointer-events:none;
      `;
      overlay.innerHTML = `
        <div style="font-size:4rem;">📄</div>
        <div style="font-family:'Orbitron',monospace;font-size:1rem;letter-spacing:0.4em;
                    color:rgba(255,213,128,0.95);text-shadow:0 0 20px rgba(255,213,128,0.6);">
          DROP FILE TO LOAD
        </div>
        <div style="font-size:0.55rem;letter-spacing:0.2em;color:rgba(255,213,128,0.5);">
          PDF · DOCX · TXT
        </div>
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
      badge.style.cssText = `
        position:fixed;bottom:52px;left:50%;
        transform:translateX(-50%);z-index:40;
        background:rgba(0,5,20,0.92);
        border:1px solid rgba(255,213,128,0.35);
        border-radius:20px;padding:5px 14px 5px 10px;
        display:flex;align-items:center;gap:8px;
        font-family:'Share Tech Mono',monospace;
        font-size:0.52rem;letter-spacing:0.1em;
        color:rgba(255,213,128,0.8);cursor:pointer;
      `;
      badge.addEventListener('click', () => window.kairosFiles.togglePanel());
      document.body.appendChild(badge);
    }
    const short = name.length > 28 ? name.slice(0, 25) + '…' : name;
    badge.innerHTML = `
      <span>📄</span>
      <span>${short}</span>
      <span onclick="event.stopPropagation();window.kairosFiles.clearFile()"
            style="color:rgba(255,213,128,0.4);cursor:pointer;margin-left:2px;">✕</span>
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
    panel.style.bottom = panelOpen ? '0' : '-500px';
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