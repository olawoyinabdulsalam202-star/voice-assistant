// ════════════════════════════════════════
//  filereader.js  —  KAIROS FILE READER
//  v2 — Enhanced
//
//  HOW TO OPEN:
//  • Click  ◈ FILE  button in right HUD
//  • Press  F  on keyboard
//  • Long-press orb 600 ms
//  • Drag any file ANYWHERE on screen
//    (full-page drop overlay activates)
//  • Say "open file" / "load file" / "read file"
//
//  SUPPORTS: PDF, DOCX, DOC, TXT
//  ◈ FILE btn must exist in your HTML HUD
//    with id="file-btn"
// ════════════════════════════════════════

(function () {

  // ── CDN (loaded lazily) ──
  const PDF_JS     = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
  const PDF_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const MAMMOTH    = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';

  function loadScript(src) {
    return new Promise((res, rej) => {
      if (document.querySelector(`script[src="${src}"]`)) { res(); return; }
      const s = document.createElement('script');
      s.src = src; s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }

  // ── STATE ──
  let activeFile   = null;   // { name, text, charCount }
  let panelOpen    = false;
  let pdfReady     = false;
  let mammothReady = false;

  // ════════════════════════════════════════
  //  PANEL UI
  // ════════════════════════════════════════
  function ensurePanel() {
    if (document.getElementById('file-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'file-panel';
    panel.style.cssText = `
      position:fixed;left:50%;bottom:-480px;
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
          <!-- + ADD FILE BUTTON -->
          <button id="file-add-btn" title="Browse for file"
                  style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.25);
                         color:var(--cyan,#00d4ff);font-family:'Orbitron',monospace;
                         font-size:1rem;line-height:1;width:28px;height:28px;
                         cursor:pointer;border-radius:3px;
                         display:flex;align-items:center;justify-content:center;
                         transition:background 0.2s,border-color 0.2s;position:relative;overflow:hidden;"
                  onmouseenter="this.style.background='rgba(0,212,255,0.16)';this.style.borderColor='rgba(0,212,255,0.5)'"
                  onmouseleave="this.style.background='rgba(0,212,255,0.08)';this.style.borderColor='rgba(0,212,255,0.25)'">
            +
            <!-- hidden file input wired to + button -->
            <input id="file-input-btn" type="file" accept=".pdf,.doc,.docx,.txt"
                   style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;" />
          </button>
          <button onclick="window.kairosFiles.togglePanel()"
                  style="background:none;border:none;color:rgba(0,212,255,0.4);cursor:pointer;font-size:1rem;
                         transition:color 0.2s;"
                  onmouseenter="this.style.color='#00d4ff'"
                  onmouseleave="this.style.color='rgba(0,212,255,0.4)'">✕</button>
        </div>
      </div>

      <!-- DROP ZONE -->
      <div id="file-dropzone"
           style="margin:16px 20px 0;border:1px dashed rgba(0,212,255,0.25);
                  border-radius:4px;padding:32px 20px;text-align:center;
                  cursor:pointer;transition:border-color 0.2s,background 0.2s;position:relative;">
        <div style="font-size:1.6rem;margin-bottom:10px;opacity:0.5;pointer-events:none;">📄</div>
        <div style="font-size:0.6rem;letter-spacing:0.2em;color:rgba(0,212,255,0.6);pointer-events:none;">
          DROP PDF, DOCX, OR TXT HERE
        </div>
        <div style="font-size:0.47rem;letter-spacing:0.15em;color:rgba(0,212,255,0.25);margin-top:6px;pointer-events:none;">
          or tap  <span style="color:rgba(0,212,255,0.45);">+</span>  above to browse
        </div>
        <!-- panel drop input -->
        <input id="file-input" type="file" accept=".pdf,.doc,.docx,.txt"
               style="position:absolute;inset:0;opacity:0;cursor:pointer;width:100%;height:100%;" />
      </div>

      <!-- STATUS -->
      <div id="file-status"
           style="margin:10px 20px 6px;font-size:0.54rem;letter-spacing:0.12em;
                  color:rgba(0,212,255,0.35);min-height:18px;text-align:center;">
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
                       padding:4px 10px;margin-left:12px;border-radius:2px;flex-shrink:0;
                       transition:color 0.2s,border-color 0.2s;"
                onmouseenter="this.style.color='#00d4ff';this.style.borderColor='rgba(0,212,255,0.4)'"
                onmouseleave="this.style.color='rgba(0,212,255,0.4)';this.style.borderColor='rgba(0,212,255,0.15)'">
          ✕ CLEAR
        </button>
      </div>

      <!-- HINTS -->
      <div style="padding:8px 20px 14px;font-size:0.42rem;letter-spacing:0.12em;
                  color:rgba(0,212,255,0.18);line-height:2.1;text-align:center;
                  border-top:1px solid rgba(0,212,255,0.06);">
        DRAG FILE ANYWHERE ON SCREEN  ·  PRESS <span style="color:rgba(0,212,255,0.4);">F</span>  ·  LONG-PRESS ORB<br>
        SAY "LOAD FILE" OR "CLEAR FILE"
      </div>
    `;

    document.body.appendChild(panel);
    wirePanelDropzone();
    wirePlusBtnInput();
  }

  // ════════════════════════════════════════
  //  FULL-PAGE DROP OVERLAY
  //  Activates whenever user drags a file
  //  anywhere on the screen
  // ════════════════════════════════════════
  function ensurePageOverlay() {
    if (document.getElementById('file-page-overlay')) return;

    const overlay = document.createElement('div');
    overlay.id = 'file-page-overlay';
    overlay.style.cssText = `
      position:fixed;inset:0;z-index:9999;
      display:none;pointer-events:none;
      border:2px dashed rgba(255,213,128,0.55);
      background:rgba(0,5,25,0.72);
      transition:opacity 0.2s ease;
      align-items:center;justify-content:center;
      flex-direction:column;gap:14px;
    `;
    overlay.innerHTML = `
      <div style="font-size:3.5rem;filter:drop-shadow(0 0 20px rgba(255,213,128,0.7));">📄</div>
      <div style="font-family:'Orbitron',monospace;font-size:0.9rem;letter-spacing:0.35em;
                  color:rgba(255,213,128,0.95);text-shadow:0 0 20px rgba(255,213,128,0.6);">
        DROP FILE TO LOAD
      </div>
      <div style="font-size:0.5rem;letter-spacing:0.2em;color:rgba(255,213,128,0.45);">
        PDF · DOCX · TXT
      </div>
    `;
    document.body.appendChild(overlay);
  }

  function wirePageDrop() {
    ensurePageOverlay();
    const overlay = document.getElementById('file-page-overlay');
    let dragCounter = 0;

    document.addEventListener('dragenter', e => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      dragCounter++;
      if (dragCounter === 1 && overlay) {
        overlay.style.display = 'flex';
        overlay.style.pointerEvents = 'all';
      }
    });

    document.addEventListener('dragleave', e => {
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        if (overlay) {
          overlay.style.display = 'none';
          overlay.style.pointerEvents = 'none';
        }
      }
    });

    document.addEventListener('dragover', e => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });

    document.addEventListener('drop', e => {
      e.preventDefault();
      dragCounter = 0;
      if (overlay) {
        overlay.style.display = 'none';
        overlay.style.pointerEvents = 'none';
      }
      const file = e.dataTransfer?.files?.[0];
      if (file) processFile(file);
    });
  }

  // ════════════════════════════════════════
  //  PANEL DROP ZONE WIRING
  // ════════════════════════════════════════
  function wirePanelDropzone() {
    const zone  = document.getElementById('file-dropzone');
    const input = document.getElementById('file-input');
    if (!zone || !input) return;

    zone.addEventListener('dragover', e => {
      e.preventDefault();
      zone.style.borderColor = 'rgba(0,212,255,0.7)';
      zone.style.background  = 'rgba(0,212,255,0.05)';
    });
    ['dragleave','dragend'].forEach(ev => zone.addEventListener(ev, () => {
      zone.style.borderColor = 'rgba(0,212,255,0.25)';
      zone.style.background  = '';
    }));
    zone.addEventListener('drop', e => {
      e.preventDefault();
      zone.style.borderColor = 'rgba(0,212,255,0.25)';
      zone.style.background  = '';
      const file = e.dataTransfer?.files?.[0];
      if (file) processFile(file);
    });
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) processFile(file);
      input.value = '';
    });
  }

  // ── Wire + button input ──
  function wirePlusBtnInput() {
    const input = document.getElementById('file-input-btn');
    if (!input) return;
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (file) processFile(file);
      input.value = '';
    });
  }

  // ════════════════════════════════════════
  //  ORB LONG-PRESS → OPEN PANEL
  // ════════════════════════════════════════
  function wireOrbLongPress() {
    const orb = document.getElementById('orb');
    if (!orb || orb._fileLongPress) return;
    orb._fileLongPress = true;
    let pressTimer = null;

    function startPress() {
      pressTimer = setTimeout(() => {
        orb.style.transform = 'scale(1.18)';
        setTimeout(() => { orb.style.transform = ''; }, 220);
        togglePanel();
      }, 600);
    }
    function cancelPress() { clearTimeout(pressTimer); }

    orb.addEventListener('touchstart',  startPress,  { passive: true });
    orb.addEventListener('touchend',    cancelPress, { passive: true });
    orb.addEventListener('touchcancel', cancelPress, { passive: true });
    orb.addEventListener('mousedown',   startPress);
    orb.addEventListener('mouseup',     cancelPress);
    orb.addEventListener('mouseleave',  cancelPress);
  }

  // ── Keyboard shortcut F ──
  function wireKeyboard() {
    document.addEventListener('keydown', e => {
      if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;
      if (e.key === 'f' || e.key === 'F') togglePanel();
    });
  }

  // ── HUD FILE button ──
  function wireFileBtn() {
    const btn = document.getElementById('file-btn');
    if (btn && !btn._fileWired) {
      btn.addEventListener('click', togglePanel);
      btn._fileWired = true;
    }
  }

  // ════════════════════════════════════════
  //  FILE PROCESSING
  // ════════════════════════════════════════
  async function processFile(file) {
    const name = file.name;
    const ext  = name.split('.').pop().toLowerCase();

    if (!['pdf','doc','docx','txt'].includes(ext)) {
      setStatus('⚠ UNSUPPORTED — USE PDF, DOCX, OR TXT');
      return;
    }

    if (panelOpen) togglePanel();

    setStatus('⏳ READING FILE...');
    updateStatusBar('▶ READING FILE...');

    try {
      let text = '';

      if (ext === 'txt') {
        text = await file.text();
      } else if (ext === 'pdf') {
        await ensurePdf();
        text = await extractPdf(file);
      } else {
        await ensureMammoth();
        text = await extractDocx(file);
      }

      if (!text || text.trim().length < 5) {
        setStatus('⚠ NO TEXT EXTRACTED — TRY ANOTHER FILE');
        updateStatusBar('▶ FILE READ FAILED');
        return;
      }

      const trimmed = text.trim().slice(0, 40000);
      activeFile = { name, text: trimmed, charCount: trimmed.length };

      setStatus('');
      updateActiveBar();
      updateStatusBar('▶ FILE LOADED — ASK ME ANYTHING');

      if (typeof window.speak === 'function')
        window.speak(`File loaded: ${name}. I've read it. What would you like to know?`);
      if (typeof window.addToHistory === 'function')
        window.addToHistory('kairos', `◈ FILE LOADED: ${name} (${Math.ceil(trimmed.length / 1000)}k chars)`);

      showFileBadge(name);

    } catch (err) {
      console.error('filereader.js error:', err);
      setStatus('⚠ ERROR READING FILE — SEE CONSOLE');
      updateStatusBar('▶ FILE READ ERROR');
    }
  }

  // ── PDF extraction ──
  async function ensurePdf() {
    if (pdfReady) return;
    await loadScript(PDF_JS);
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER;
    pdfReady = true;
  }

  async function extractPdf(file) {
    const buffer  = await file.arrayBuffer();
    const pdf     = await window.pdfjsLib.getDocument({ data: buffer }).promise;
    const parts   = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page    = await pdf.getPage(i);
      const content = await page.getTextContent();
      parts.push(content.items.map(s => s.str).join(' '));
    }
    return parts.join('\n');
  }

  // ── DOCX extraction ──
  async function ensureMammoth() {
    if (mammothReady) return;
    await loadScript(MAMMOTH);
    mammothReady = true;
  }

  async function extractDocx(file) {
    const buffer = await file.arrayBuffer();
    const result = await window.mammoth.extractRawText({ arrayBuffer: buffer });
    return result.value;
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

  // ── HUD badge ──
  function showFileBadge(name) {
    let badge = document.getElementById('file-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.id = 'file-badge';
      badge.style.cssText = `
        position:fixed;bottom:52px;left:50%;
        transform:translateX(-50%);
        z-index:40;
        background:rgba(0,5,20,0.92);
        border:1px solid rgba(255,213,128,0.35);
        border-radius:20px;
        padding:5px 14px 5px 10px;
        display:flex;align-items:center;gap:8px;
        font-family:'Share Tech Mono',monospace;
        font-size:0.52rem;letter-spacing:0.1em;
        color:rgba(255,213,128,0.8);
        cursor:pointer;
        box-shadow:0 0 16px rgba(255,213,128,0.1);
        transition:box-shadow 0.2s;
      `;
      badge.addEventListener('click', () => window.kairosFiles.togglePanel());
      badge.addEventListener('mouseenter', () => badge.style.boxShadow = '0 0 24px rgba(255,213,128,0.25)');
      badge.addEventListener('mouseleave', () => badge.style.boxShadow = '0 0 16px rgba(255,213,128,0.1)');
      document.body.appendChild(badge);
    }
    const short = name.length > 28 ? name.slice(0, 25) + '…' : name;
    badge.innerHTML = `
      <span style="font-size:0.85rem;">📄</span>
      <span>${short}</span>
      <span onclick="event.stopPropagation();window.kairosFiles.clearFile()"
            style="color:rgba(255,213,128,0.4);font-size:0.85rem;cursor:pointer;margin-left:2px;"
            onmouseenter="this.style.color='#ffd580'"
            onmouseleave="this.style.color='rgba(255,213,128,0.4)'">✕</span>
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
    panel.style.bottom = panelOpen ? '0' : '-480px';
    const btn = document.getElementById('file-btn');
    if (btn) btn.classList.toggle('active', panelOpen || !!activeFile);
    if (panelOpen) updateActiveBar();
  }

  // ── Voice commands ──
  function handleVoice(text) {
    const lower = text.toLowerCase();
    if (['open file','load file','upload file','load document',
         'open document','read file','read document','file reader',
         'open reader','attach file'].some(p => lower.includes(p))) {
      togglePanel();
      return "Opening file reader. Drop a PDF, Word document, or text file anywhere on screen — or tap the + button to browse.";
    }
    if (['clear file','remove file','close file','forget file','unload file'].some(p => lower.includes(p))) {
      if (activeFile) { clearFile(); return 'File cleared, Mr. Abdulsalam.'; }
      return 'No file is currently loaded.';
    }
    return null;
  }

  // ── Context injector (for askKairos) ──
  function getFileContext() {
    if (!activeFile) return null;
    return `[DOCUMENT CONTEXT — file: "${activeFile.name}"]\n${activeFile.text}\n[END DOCUMENT CONTEXT]`;
  }

  // ════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════
  function init() {
    ensurePanel();
    wirePageDrop();   // ← full-page drop anywhere
    function wire() {
      wireOrbLongPress();
      wireKeyboard();
      wireFileBtn();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
  }

  window.kairosFiles = { togglePanel, clearFile, handleVoice, getFileContext };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();