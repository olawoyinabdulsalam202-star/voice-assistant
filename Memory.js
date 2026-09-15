// ════════════════════════════════════════
//  memory.js  —  KAIROS PERSONALITY MEMORY
//  v1
//
//  Kairos remembers things across sessions:
//  • User name/preferences
//  • Topics discussed
//  • Things you've told it about yourself
//  • Custom facts ("remember that I prefer...")
//
//  HOW IT WORKS:
//  1. Every conversation is summarised and
//     saved to backend SQLite via /memory
//  2. On load, memories are fetched and
//     injected into every askKairos call
//  3. Voice commands: "remember that..."
//     "what do you remember?" "forget..."
//
//  REQUIRES: memory endpoints in backend.py
//  (see memory_backend_patch.py)
// ════════════════════════════════════════

(function () {

  // Same-origin — works on localhost AND once this is deployed to a real host.
  const BACKEND = '';

  function authHeaders(extra) {
    const token = localStorage.getItem('kairos_token') || '';
    return Object.assign({ 'Authorization': `Bearer ${token}` }, extra || {});
  }

  // ── IN-MEMORY CACHE ──
  let memoryCache = [];   // [{ id, key, value, created_at }]
  let memoryLoaded = false;

  // ════════════════════════════════════════
  //  LOAD MEMORIES FROM BACKEND
  // ════════════════════════════════════════
  async function loadMemories() {
    try {
      const res = await fetch(`${BACKEND}/memory`, { headers: authHeaders() });
      if (res.status === 403) { memoryLoaded = true; return; } // free plan — no memory access
      if (!res.ok) return;
      const data = await res.json();
      memoryCache = data.memories || [];
      memoryLoaded = true;
    } catch (err) {
      console.warn('memory.js: could not load memories:', err.message);
      memoryLoaded = true; // don't block — just no memmory
    }
  }

  // ════════════════════════════════════════
  //  SAVE A MEMORY TO BACKEND
  // ════════════════════════════════════════
  async function saveMemory(key, value) {
    try {
      const res = await fetch(`${BACKEND}/memory`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ key, value })
      });
      if (res.status === 402 || res.status === 403) {
        const data = await res.json().catch(() => ({}));
        window.showNotification && window.showNotification(
          data.error || 'Memory limit reached. Upgrade to Pro for more.'
        );
        return null;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        window.showNotification && window.showNotification(data.error || `Memory save failed (${res.status}).`);
        return null;
      }
      const data = await res.json();
      // update cache
      const existing = memoryCache.findIndex(m => m.key === key);
      if (existing >= 0) memoryCache[existing] = data.memory;
      else memoryCache.push(data.memory);
      return data.memory;
    } catch (err) {
      console.warn('memory.js: save failed:', err.message);
      return null;
    }
  }

  // ════════════════════════════════════════
  //  DELETE A MEMORY
  // ════════════════════════════════════════
  async function deleteMemory(key) {
    try {
      await fetch(`${BACKEND}/memory/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: authHeaders()
      });
      memoryCache = memoryCache.filter(m => m.key !== key);
    } catch (err) {
      console.warn('memory.js: delete failed:', err.message);
    }
  }

  async function clearAllMemories() {
    try {
      await fetch(`${BACKEND}/memory`, { method: 'DELETE', headers: authHeaders() });
      memoryCache = [];
    } catch (err) {
      console.warn('memory.js: clear failed:', err.message);
    }
  }

  // ════════════════════════════════════════
  //  BUILD MEMORY CONTEXT STRING
  //  Injected into every askKairos call
  // ════════════════════════════════════════
  function buildMemoryContext() {
    if (!memoryCache.length) return '';
    const lines = memoryCache.map(m => `- ${m.key}: ${m.value}`).join('\n');
    return `[MEMORY — things you remember about ${(window.getKairosName && window.getKairosName()) || "the user"}]\n${lines}\n[END MEMORY]`;
  }

  // ════════════════════════════════════════
  //  VOICE COMMAND PARSING
  // ════════════════════════════════════════

  // "remember that I prefer dark mode"
  // "remember I hate mornings"
  // "my favourite language is Python" → save automatically
  const REMEMBER_PATTERNS = [
    /^(?:kairos,?\s+)?remember (?:that\s+)?(?:my\s+)?(.+)/i,
    /^(?:kairos,?\s+)?note that (.+)/i,
    /^(?:kairos,?\s+)?don't forget (?:that\s+)?(.+)/i,
    /^(?:kairos,?\s+)?keep in mind (?:that\s+)?(.+)/i,
    /^(?:kairos,?\s+)?make a note (?:that\s+)?(.+)/i,
  ];

  const RECALL_PATTERNS = [
    'what do you remember',
    'what do you know about me',
    'what have i told you',
    'show my memories',
    'list your memories',
    'what do you recall',
    'open memory',
    'show memory',
  ];

  const FORGET_PATTERNS = [
    /^(?:kairos,?\s+)?forget (?:that\s+|about\s+)?(.+)/i,
    /^(?:kairos,?\s+)?delete (?:the\s+)?memory (?:about\s+)?(.+)/i,
    /^(?:kairos,?\s+)?remove (?:the\s+)?memory (?:about\s+)?(.+)/i,
  ];

  // Auto-extract facts from natural speech
  // e.g. "my favourite language is Python"
  const AUTO_FACT_PATTERNS = [
    { regex: /my (?:favourite|favorite|preferred?) (.+?) is (.+)/i,    keyFn: m => `favourite ${m[1]}`,   valFn: m => m[2] },
    { regex: /i (?:love|like|enjoy|prefer) (.+)/i,                     keyFn: m => `likes`,               valFn: m => m[1] },
    { regex: /i (?:hate|dislike|don't like|cannot stand) (.+)/i,       keyFn: m => `dislikes`,            valFn: m => m[1] },
    { regex: /i (?:am|'m) (?:a\s+)?(.+)/i,                            keyFn: m => `identity`,            valFn: m => m[1] },
    { regex: /i work (?:at|for|in) (.+)/i,                             keyFn: m => `works at`,            valFn: m => m[1] },
    { regex: /i live in (.+)/i,                                         keyFn: m => `lives in`,            valFn: m => m[1] },
    { regex: /i (?:speak|know) (.+)/i,                                  keyFn: m => `languages`,           valFn: m => m[1] },
    { regex: /my (?:name|nickname) is (.+)/i,                           keyFn: m => `name`,                valFn: m => m[1] },
    { regex: /my (?:birthday|birth date) is (.+)/i,                     keyFn: m => `birthday`,            valFn: m => m[1] },
    { regex: /call me (.+)/i,                                           keyFn: m => `preferred name`,      valFn: m => m[1] },
  ];

  // ── HANDLE VOICE INPUT ──
  async function handleVoice(text) {
    const lower = text.toLowerCase().trim();

    // RECALL
    if (RECALL_PATTERNS.some(p => lower.includes(p))) {
      togglePanel();
      if (!memoryCache.length) return `I don't have any memories stored yet, ${(window.getKairosName && window.getKairosName()) || "friend"}.`;
      const summary = memoryCache.slice(0, 5).map(m => `${m.key}: ${m.value}`).join('. ');
      return `Here's what I remember: ${summary}.`;
    }

    // FORGET
    for (const pattern of FORGET_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const query = match[1].trim().toLowerCase();
        const found = memoryCache.find(m =>
          m.key.toLowerCase().includes(query) ||
          m.value.toLowerCase().includes(query)
        );
        if (found) {
          await deleteMemory(found.key);
          return `Got it, I've forgotten that, ${(window.getKairosName && window.getKairosName()) || "friend"}.`;
        }
        return `I couldn't find a memory matching "${query}".`;
      }
    }

    // FORGET ALL
    if (lower.includes('forget everything') || lower.includes('clear all memories') || lower.includes('wipe your memory')) {
      await clearAllMemories();
      return `Memory cleared. I've forgotten everything, ${(window.getKairosName && window.getKairosName()) || "friend"}.`;
    }

    // EXPLICIT REMEMBER
    for (const pattern of REMEMBER_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        const fact = match[1].trim();
        // try to extract key/value from the fact
        let key = 'note', value = fact;
        for (const ap of AUTO_FACT_PATTERNS) {
          const am = fact.match(ap.regex);
          if (am) { key = ap.keyFn(am).trim(); value = ap.valFn(am).replace(/[.!?]+$/, '').trim(); break; }
        }
        if (key === 'note') {
          // use first 4 words as key
          key = fact.split(' ').slice(0, 4).join(' ').replace(/[^a-zA-Z0-9 ]/g, '').trim();
          value = fact;
        }
        const saved = await saveMemory(key, value);
        if (!saved) return "I couldn't save that memory. Please check your login, connection, or memory limit.";
        return `Noted, ${(window.getKairosName && window.getKairosName()) || "friend"}. I'll remember that.`;
      }
    }

    // AUTO-EXTRACT facts from normal conversation
    for (const ap of AUTO_FACT_PATTERNS) {
      const m = text.match(ap.regex);
      if (m) {
        const key   = ap.keyFn(m).trim();
        const value = ap.valFn(m).replace(/[.!?]+$/, '').trim();
        if (value.length > 2 && value.length < 120) {
          await saveMemory(key, value);
          // don't return — let normal AI processing continue
        }
        break;
      }
    }

    return null; // not a memory command — let processCommand continue
  }

  // ════════════════════════════════════════
  //  MEMORY PANEL UI
  // ════════════════════════════════════════
  let panelOpen = false;

  function ensurePanel() {
    if (document.getElementById('mem-panel')) return;

    const panel = document.createElement('div');
    panel.id = 'mem-panel';
    // B3: width uses min() so a visible edge remains on a 360px phone.
    // Redesign: glass edge-drawer (.kx-drawer) + fade/scale motion
    // (.kx-panel--left) instead of the old off-screen left:-100% slide.
    panel.className = 'kx-drawer kx-drawer--left kx-panel kx-panel--left';
    panel.innerHTML = `
      <div class="kx-drawer__head">
        <span class="kx-drawer__title"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-memory"/></svg> MEMORY CORE</span>
        <button class="kx-icon-mini" onclick="window.kairosMemory.togglePanel()" aria-label="Close memory panel"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></button>
      </div>

      <!-- Manual add -->
      <div class="kx-drawer__section">
        <div class="kx-drawer__eyebrow"><svg class="ic ic--sm" aria-hidden="true"><use href="/icons.svg#ic-plus"/></svg> ADD MEMORY</div>
        <div class="glass-field">
          <input id="mem-key" class="glass-input" placeholder="Label (e.g. favourite food)" />
          <input id="mem-val" class="glass-input" placeholder="Value (e.g. jollof rice)" />
          <button id="mem-add-btn" class="glass-btn glass-btn--sm glass-btn--block">SAVE MEMORY</button>
        </div>
      </div>

      <!-- Memory list -->
      <div id="mem-list" class="kx-drawer__list kx-scroll"></div>

      <!-- Footer hint -->
      <div class="kx-drawer__foot">
        <div class="kx-drawer__hint">
          SAY: "remember that I prefer..."<br>
          SAY: "what do you remember?"<br>
          SAY: "forget that I..."<br>
          PRESS <b>M</b> TO OPEN / CLOSE
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    // Wire add button
    const addBtn = document.getElementById('mem-add-btn');
    if (addBtn) {
      addBtn.addEventListener('click', async () => {
        const key = (document.getElementById('mem-key')?.value || '').trim();
        const val = (document.getElementById('mem-val')?.value || '').trim();
        if (!key || !val) return;
        const saved = await saveMemory(key, val);
        if (!saved) {
          window.showNotification && window.showNotification('Memory could not be saved. Check your login and connection.');
          return;
        }
        document.getElementById('mem-key').value = '';
        document.getElementById('mem-val').value = '';
        renderPanel();
        if (typeof window.speak === 'function') window.speak('Memory saved.');
      });
    }

    // Enter key on val input
    document.getElementById('mem-val')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('mem-add-btn')?.click();
    });
  }

  function renderPanel() {
    const list = document.getElementById('mem-list');
    if (!list) return;

    if (!memoryCache.length) {
      list.innerHTML = `<div class="kx-empty">NO MEMORIES STORED<br><span>Tell me something to remember.</span></div>`;
      return;
    }

    // S6: the delete button previously did
    //   onclick="..._delete('${escapeHtml(m.key)}')"
    // which escapes for HTML but NOT for a JS string literal — a key
    // containing an apostrophe broke out of the quotes. Using a data
    // attribute plus a delegated listener removes the injection path
    // entirely instead of trying to escape two contexts at once.
    list.innerHTML = memoryCache.map(m => `
      <div class="kx-item">
        <div class="kx-item__main">
          <div class="kx-item__label">${escapeHtml(m.key)}</div>
          <div class="kx-item__value">${escapeHtml(m.value)}</div>
        </div>
        <button class="mem-edit-btn kx-icon-mini" data-key="${escapeHtml(m.key)}" aria-label="Edit memory"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-pencil"/></svg></button>
        <button class="mem-del-btn kx-icon-mini kx-icon-mini--danger" data-key="${escapeHtml(m.key)}" aria-label="Delete memory"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-trash"/></svg></button>
      </div>
    `).join('');

    list.querySelectorAll('.mem-del-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        await deleteMemory(btn.dataset.key);
        renderPanel();
      });
    });
    list.querySelectorAll('.mem-edit-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const existing = memoryCache.find(m => m.key === btn.dataset.key);
        if (!existing) return;
        const value = prompt('Memory value:', existing.value);
        if (value == null || !value.trim()) return;
        const saved = await saveMemory(existing.key, value.trim());
        if (saved) renderPanel();
      });
    });
  }

  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function togglePanel() {
    ensurePanel();
    const panel = document.getElementById('mem-panel');
    if (!panel) return;
    panelOpen = !panelOpen;
    panel.classList.toggle('open', panelOpen);                  // fade+scale (was left:0 / -100% slide)
    document.body.classList.toggle('kx-panel-open', panelOpen); // dims the orb while open (Brief §5)
    const btn = document.getElementById('mem-btn');
    if (btn) btn.classList.toggle('active', panelOpen);
    if (panelOpen) renderPanel();
  }

  // ════════════════════════════════════════
  //  PATCH askKairos — inject memory context
  //
  //  A7 FIX: previously called original(augmented), which meant the
  //  whole memory block was stored in conversation history by brain.js
  //  and re-sent on every subsequent turn. Now the raw message is kept
  //  separate from the augmented payload.
  // ════════════════════════════════════════
  function wrap(fnName) {
    const original = window[fnName];
    if (!original || original._memPatched) return false;

    if (fnName === 'askKairosStream') {
      window[fnName] = async function (userMessage, onDelta, opts) {
        const options = opts || {};
        const base    = options.augmented || userMessage;
        const ctx     = buildMemoryContext();
        return original(userMessage, onDelta, {
          ...options,
          raw: options.raw || userMessage,
          augmented: ctx ? `${ctx}\n\n${base}` : base,
        });
      };
    } else {
      window[fnName] = async function (userMessage, opts) {
        const options = opts || {};
        const base    = options.augmented || userMessage;
        const ctx     = buildMemoryContext();
        return original(userMessage, {
          ...options,
          raw: options.raw || userMessage,
          augmented: ctx ? `${ctx}\n\n${base}` : base,
        });
      };
    }

    window[fnName]._memPatched = true;
    return true;
  }

  function patchAskKairos() {
    const done = wrap('askKairos');
    wrap('askKairosStream');
    if (!done && !(window.askKairos && window.askKairos._memPatched)) {
      setTimeout(patchAskKairos, 400);
    }
  }

  // ════════════════════════════════════════
  //  KEYBOARD SHORTCUT  M
  // ════════════════════════════════════════
  // NOTE: no keyboard shortcut bound here anymore — script.js's global
  // keydown handler already binds "M" to window.kairosMemory.togglePanel().
  // Having both fire caused the same open-then-instantly-close bug as
  // the double-bound mem-btn above.

  // ════════════════════════════════════════
  //  WIRE MEM BUTTON IN HUD (id="mem-btn")
  // ════════════════════════════════════════
  // NOTE: mem-btn is wired once, centrally, in index.htm's load listener
  // (calls window.kairosMemory.togglePanel()). Binding it again here caused
  // togglePanel() to run twice per click — opening then instantly closing
  // the panel again, so the button looked broken.
  function wireMemBtn() { /* no-op — kept so init() below doesn't error */ }

  // ════════════════════════════════════════
  //  PUBLIC API
  // ════════════════════════════════════════
  window.kairosMemory = {
    togglePanel,
    handleVoice,
    saveMemory,
    loadMemories,
    getContext: buildMemoryContext,
    _delete: async (key) => { await deleteMemory(key); renderPanel(); }
  };

  // ════════════════════════════════════════
  //  INIT
  // ════════════════════════════════════════
  async function init() {
    await loadMemories();
    ensurePanel();
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', wireMemBtn);
    } else {
      wireMemBtn();
    }
    patchAskKairos();
  }

  init();

})();
