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

  const BACKEND = 'https://kairos-oabh.onrender.com';
  const USER_ID = 'mr_abdulsalam'; // fixed user — change if multi-user

  // ── IN-MEMORY CACHE ──
  let memoryCache = [];   // [{ id, key, value, created_at }]
  let memoryLoaded = false;

  // ════════════════════════════════════════
  //  LOAD MEMORIES FROM BACKEND
  // ════════════════════════════════════════
  async function loadMemories() {
    try {
      const res = await fetch(`${BACKEND}/memory?user=${USER_ID}`);
      if (!res.ok) return;
      const data = await res.json();
      memoryCache = data.memories || [];
      memoryLoaded = true;
    } catch (err) {
      console.warn('memory.js: could not load memories:', err.message);
      memoryLoaded = true; // don't block — just no memory
    }
  }

  // ════════════════════════════════════════
  //  SAVE A MEMORY TO BACKEND
  // ════════════════════════════════════════
  async function saveMemory(key, value) {
    try {
      const res = await fetch(`${BACKEND}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user: USER_ID, key, value })
      });
      if (!res.ok) return null;
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
      await fetch(`${BACKEND}/memory/${USER_ID}/${encodeURIComponent(key)}`, {
        method: 'DELETE'
      });
      memoryCache = memoryCache.filter(m => m.key !== key);
    } catch (err) {
      console.warn('memory.js: delete failed:', err.message);
    }
  }

  async function clearAllMemories() {
    try {
      await fetch(`${BACKEND}/memory/${USER_ID}`, { method: 'DELETE' });
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
    return `[MEMORY — things you remember about Mr. Abdulsalam]\n${lines}\n[END MEMORY]`;
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
      if (!memoryCache.length) return "I don't have any memories stored yet, Mr. Abdulsalam.";
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
          return `Got it, I've forgotten that, Mr. Abdulsalam.`;
        }
        return `I couldn't find a memory matching "${query}".`;
      }
    }

    // FORGET ALL
    if (lower.includes('forget everything') || lower.includes('clear all memories') || lower.includes('wipe your memory')) {
      await clearAllMemories();
      return "Memory cleared. I've forgotten everything, Mr. Abdulsalam.";
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
        await saveMemory(key, value);
        return `Noted, Mr. Abdulsalam. I'll remember that.`;
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
    panel.style.cssText = `
      position:fixed;left:-380px;top:0;bottom:0;width:340px;z-index:50;
      background:rgba(0,2,15,0.97);border-right:1px solid rgba(0,212,255,0.15);
      transition:left 0.4s ease;display:flex;flex-direction:column;
      font-family:'Share Tech Mono',monospace;
    `;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;
                  padding:20px 20px 14px;border-bottom:1px solid rgba(0,212,255,0.1);">
        <span style="font-family:'Orbitron',monospace;font-size:0.65rem;
                     letter-spacing:0.3em;color:var(--cyan,#00d4ff);">◈ MEMORY CORE</span>
        <button onclick="window.kairosMemory.togglePanel()"
                style="background:none;border:none;color:rgba(0,212,255,0.4);
                       cursor:pointer;font-size:1rem;transition:color 0.2s;"
                onmouseenter="this.style.color='#00d4ff'"
                onmouseleave="this.style.color='rgba(0,212,255,0.4)'">✕</button>
      </div>

      <!-- Manual add -->
      <div style="padding:14px 20px;border-bottom:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.47rem;letter-spacing:0.2em;color:rgba(0,212,255,0.3);margin-bottom:8px;">+ ADD MEMORY</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <input id="mem-key" placeholder="Label (e.g. favourite food)"
                 style="background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.15);
                        color:rgba(0,212,255,0.8);font-family:'Share Tech Mono',monospace;
                        font-size:0.6rem;padding:7px 10px;outline:none;border-radius:2px;
                        width:100%;box-sizing:border-box;" />
          <input id="mem-val" placeholder="Value (e.g. jollof rice)"
                 style="background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.15);
                        color:rgba(0,212,255,0.8);font-family:'Share Tech Mono',monospace;
                        font-size:0.6rem;padding:7px 10px;outline:none;border-radius:2px;
                        width:100%;box-sizing:border-box;" />
          <button id="mem-add-btn"
                  style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.25);
                         color:var(--cyan,#00d4ff);font-family:'Share Tech Mono',monospace;
                         font-size:0.55rem;letter-spacing:0.15em;padding:7px;cursor:pointer;
                         border-radius:2px;transition:background 0.2s;"
                  onmouseenter="this.style.background='rgba(0,212,255,0.16)'"
                  onmouseleave="this.style.background='rgba(0,212,255,0.08)'">SAVE MEMORY</button>
        </div>
      </div>

      <!-- Memory list -->
      <div id="mem-list" style="flex:1;overflow-y:auto;padding:12px 20px;
           scrollbar-width:thin;scrollbar-color:rgba(0,212,255,0.2) transparent;"></div>

      <!-- Footer hint -->
      <div style="padding:10px 20px 16px;border-top:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.43rem;letter-spacing:0.13em;color:rgba(0,212,255,0.2);line-height:2;">
          SAY: "remember that I prefer..."<br>
          SAY: "what do you remember?"<br>
          SAY: "forget that I..."<br>
          PRESS <span style="color:rgba(0,212,255,0.4);">M</span> TO OPEN / CLOSE
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
        await saveMemory(key, val);
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
      list.innerHTML = `
        <div style="font-size:0.56rem;letter-spacing:0.12em;color:rgba(0,212,255,0.2);
                    margin-top:24px;text-align:center;line-height:2.2;">
          NO MEMORIES STORED<br>
          <span style="font-size:0.46rem;">Tell me something to remember.</span>
        </div>`;
      return;
    }

    const itemStyle = `background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.1);
                       border-radius:2px;padding:10px 12px;margin-bottom:8px;
                       display:flex;justify-content:space-between;align-items:flex-start;gap:8px;`;

    list.innerHTML = memoryCache.map(m => `
      <div style="${itemStyle}">
        <div style="flex:1;min-width:0;">
          <div style="font-size:0.5rem;letter-spacing:0.18em;color:rgba(0,212,255,0.35);
                      margin-bottom:3px;text-transform:uppercase;">${escapeHtml(m.key)}</div>
          <div style="font-size:0.62rem;color:var(--cyan,#00d4ff);
                      white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(m.value)}</div>
        </div>
        <button onclick="window.kairosMemory._delete('${escapeHtml(m.key)}')"
                style="background:none;border:1px solid rgba(0,212,255,0.12);
                       color:rgba(0,212,255,0.3);font-size:0.65rem;cursor:pointer;
                       padding:2px 7px;flex-shrink:0;border-radius:2px;transition:color 0.2s;"
                onmouseenter="this.style.color='#00d4ff'"
                onmouseleave="this.style.color='rgba(0,212,255,0.3)'">✕</button>
      </div>
    `).join('');
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
    panel.style.left = panelOpen ? '0' : '-380px';
    const btn = document.getElementById('mem-btn');
    if (btn) btn.classList.toggle('active', panelOpen);
    if (panelOpen) renderPanel();
  }

  // ════════════════════════════════════════
  //  PATCH askKairos — inject memory context
  // ════════════════════════════════════════
  function patchAskKairos() {
    if (!window.askKairos) { setTimeout(patchAskKairos, 400); return; }
    if (window.askKairos._memPatched) return;

    const original = window.askKairos;
    window.askKairos = async function (userMessage, ...rest) {
      const ctx = buildMemoryContext();
      const augmented = ctx ? `${ctx}\n\n${userMessage}` : userMessage;
      return original(augmented, ...rest);
    };
    window.askKairos._memPatched = true;
  }

  // ════════════════════════════════════════
  //  KEYBOARD SHORTCUT  M
  // ════════════════════════════════════════
  document.addEventListener('keydown', e => {
    if (['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
    if (e.key === 'm' || e.key === 'M') togglePanel();
  });

  // ════════════════════════════════════════
  //  WIRE MEM BUTTON IN HUD (id="mem-btn")
  // ════════════════════════════════════════
  function wireMemBtn() {
    const btn = document.getElementById('mem-btn');
    if (btn && !btn._memWired) {
      btn.addEventListener('click', togglePanel);
      btn._memWired = true;
    }
  }

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