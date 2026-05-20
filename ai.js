// ════════════════════════════════════════
//  ai.js  —  KAIROS AI + REMINDERS
//  Load order: ai.js BEFORE script.js
//  Note: File Reader moved to filereader.js
// ════════════════════════════════════════

// ════════════════════════════════════════
//  REMINDERS MODULE
// ════════════════════════════════════════
(function () {

  const STORAGE_KEY = 'kairos_reminders';
  let reminders = [];
  let tickInterval = null;
  let panelOpen = false;

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) reminders = JSON.parse(raw);
      const cutoff = Date.now() - 86400000;
      reminders = reminders.filter(r => !r.fired || r.triggerAt > cutoff);
    } catch (e) { reminders = []; }
  }

  function save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(reminders)); } catch (e) {}
  }

  function uid() { return Math.random().toString(36).slice(2, 9); }

  function fmtTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function parseReminderCommand(text) {
    const lower = text.toLowerCase();
    const triggerPhrases = ['remind me', 'set a reminder', 'set reminder', 'reminder in', 'alert me', 'notify me'];
    if (!triggerPhrases.some(p => lower.includes(p))) return null;

    const patterns = [
      { regex: /in\s+(\d+(?:\.\d+)?)\s*hour/,  multiplier: 60    },
      { regex: /in\s+(\d+(?:\.\d+)?)\s*min/,   multiplier: 1     },
      { regex: /in\s+(\d+(?:\.\d+)?)\s*sec/,   multiplier: 1/60  },
      { regex: /in\s+an?\s+hour/,               multiplier: 60, fixed: 1 },
      { regex: /in\s+half\s+an?\s+hour/,        multiplier: 30, fixed: 1 },
    ];

    let minutes = null;
    for (const p of patterns) {
      const m = lower.match(p.regex);
      if (m) { minutes = p.fixed ? p.multiplier : parseFloat(m[1]) * p.multiplier; break; }
    }
    if (minutes === null || minutes <= 0 || minutes > 1440) return null;

    let label = '';
    const labelMatch = text.match(/(?:\bto\b|\bfor\b|\babout\b|\bthat\b)\s+(.+)$/i);
    if (labelMatch) {
      label = labelMatch[1].trim();
      label = label.replace(/\bin\s+\d+(?:\.\d+)?\s*(?:hour|min|sec)\w*/gi, '').trim();
      label = label.replace(/\bin\s+(?:an?|half\s+an?)\s+hour/gi, '').trim();
      label = label.replace(/\bplease\b/gi, '').trim();
      label = label.replace(/[,.\s]+$/, '').trim();
    } else {
      label = 'Your reminder';
    }
    label = label.charAt(0).toUpperCase() + label.slice(1);
    return { minutes, label };
  }

  function addReminder(minutes, label) {
    const triggerAt = Date.now() + Math.round(minutes * 60000);
    const reminder = { id: uid(), label, triggerAt, fired: false, createdAt: Date.now() };
    reminders.push(reminder);
    save(); renderPanel();
    return reminder;
  }

  function cancelReminder(query) {
    const lower = query.toLowerCase();
    if (lower.includes('all')) {
      const count = reminders.filter(r => !r.fired).length;
      reminders = reminders.filter(r => r.fired);
      save(); renderPanel();
      return count > 0 ? `Cancelled all ${count} pending reminder${count !== 1 ? 's' : ''}.` : 'No active reminders to cancel.';
    }
    if (lower.includes('last') || lower.includes('latest')) {
      const pending = reminders.filter(r => !r.fired);
      if (!pending.length) return 'No active reminders to cancel.';
      const last = pending[pending.length - 1];
      last.fired = true; save(); renderPanel();
      return `Cancelled reminder: "${last.label}".`;
    }
    const pending = reminders.filter(r => !r.fired);
    const words = lower.replace(/cancel|reminder|remind/g, '').trim().split(/\s+/).filter(Boolean);
    const match = pending.find(r => words.some(w => r.label.toLowerCase().includes(w)));
    if (match) { match.fired = true; save(); renderPanel(); return `Cancelled reminder: "${match.label}".`; }
    return "I couldn't find a matching reminder to cancel.";
  }

  function tick() {
    const now = Date.now();
    const due = reminders.filter(r => !r.fired && r.triggerAt <= now);
    due.forEach(r => { r.fired = true; fireReminder(r); });
    if (due.length) { save(); renderPanel(); }
  }

  function fireReminder(r) {
    const msg = `Reminder, Mr. Abdulsalam: ${r.label}`;
    if (typeof window.speak === 'function') window.speak(msg);
    const greetingEl = document.getElementById('greeting');
    if (greetingEl) {
      greetingEl.textContent = `⏱ ${r.label}`;
      setTimeout(() => { if (greetingEl.textContent === `⏱ ${r.label}`) greetingEl.textContent = ''; }, 8000);
    }
    showToast(r.label);
    if (typeof window.addToHistory === 'function') window.addToHistory('kairos', `⏱ REMINDER: ${r.label}`);
  }

  // ── DISMISS TOAST ──
  function dismissToast() {
    const toast = document.getElementById('rem-toast');
    if (!toast) return;
    clearTimeout(toast._timeout);
    toast.style.transform = 'translateX(-50%) translateY(-80px)';
    toast.style.opacity = '0';
    toast.style.pointerEvents = 'none';
  }

  window._kairosToastDismiss = dismissToast;

  function showToast(label) {
    let toast = document.getElementById('rem-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rem-toast';
      toast.style.cssText = `
        position:fixed;top:28px;left:50%;
        transform:translateX(-50%) translateY(-80px);
        z-index:999;background:rgba(0,5,20,0.96);
        border:1px solid rgba(0,212,255,0.4);
        border-top:2px solid var(--cyan,#00d4ff);
        color:var(--cyan,#00d4ff);font-family:'Orbitron',monospace;
        font-size:0.72rem;letter-spacing:0.15em;
        padding:14px 40px 14px 24px;min-width:280px;text-align:center;
        box-shadow:0 0 30px rgba(0,212,255,0.2);
        transition:transform 0.4s cubic-bezier(0.22,1,0.36,1),opacity 0.4s ease;
        opacity:0;pointer-events:none;
      `;
      document.body.appendChild(toast);
    }
    toast.innerHTML = `
      <div style="font-size:0.5rem;letter-spacing:0.3em;color:rgba(0,212,255,0.45);margin-bottom:6px;">⏱ REMINDER</div>
      <div>${label}</div>
      <button onclick="window._kairosToastDismiss()"
              style="position:absolute;top:8px;right:10px;background:none;border:none;
                     color:rgba(0,212,255,0.35);font-size:0.9rem;cursor:pointer;
                     line-height:1;padding:2px 5px;transition:color 0.2s;"
              onmouseenter="this.style.color='#00d4ff'"
              onmouseleave="this.style.color='rgba(0,212,255,0.35)'">✕</button>
    `;
    requestAnimationFrame(() => {
      toast.style.transform = 'translateX(-50%) translateY(0)';
      toast.style.opacity = '1';
      toast.style.pointerEvents = 'auto';
    });
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(dismissToast, 8000);
  }

  function ensurePanel() {
    if (document.getElementById('rem-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'rem-panel';
    panel.style.cssText = `
      position:fixed;right:-360px;top:0;bottom:0;width:340px;z-index:50;
      background:rgba(0,2,15,0.97);border-left:1px solid rgba(0,212,255,0.15);
      transition:right 0.4s ease;display:flex;flex-direction:column;
      font-family:'Share Tech Mono',monospace;
    `;
    panel.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:20px 20px 14px;border-bottom:1px solid rgba(0,212,255,0.1);">
        <span style="font-family:'Orbitron',monospace;font-size:0.65rem;letter-spacing:0.3em;color:var(--cyan,#00d4ff);">⏱ REMINDERS</span>
        <button onclick="window.kairosReminders.togglePanel()" style="background:none;border:none;color:rgba(0,212,255,0.4);cursor:pointer;font-size:1rem;">✕</button>
      </div>
      <div style="padding:14px 20px;border-bottom:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.48rem;letter-spacing:0.2em;color:rgba(0,212,255,0.3);margin-bottom:8px;">+ ADD MANUALLY</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <input id="rem-input-label" placeholder="Reminder label..."
                 style="background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.15);color:rgba(0,212,255,0.8);
                        font-family:'Share Tech Mono',monospace;font-size:0.62rem;padding:7px 10px;outline:none;
                        letter-spacing:0.05em;border-radius:2px;width:100%;box-sizing:border-box;" />
          <div style="display:flex;gap:6px;">
            <input id="rem-input-mins" type="number" min="1" max="1440" placeholder="Minutes"
                   style="background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.15);color:rgba(0,212,255,0.8);
                          font-family:'Share Tech Mono',monospace;font-size:0.62rem;padding:7px 10px;outline:none;
                          letter-spacing:0.05em;border-radius:2px;flex:1;box-sizing:border-box;" />
            <button id="rem-add-btn"
                    style="background:rgba(0,212,255,0.08);border:1px solid rgba(0,212,255,0.25);color:var(--cyan,#00d4ff);
                           font-family:'Share Tech Mono',monospace;font-size:0.58rem;letter-spacing:0.15em;
                           padding:0 14px;cursor:pointer;border-radius:2px;transition:background 0.2s;">SET</button>
          </div>
        </div>
      </div>
      <div id="rem-list" style="flex:1;overflow-y:auto;padding:12px 20px;scrollbar-width:thin;scrollbar-color:rgba(0,212,255,0.2) transparent;"></div>
      <div style="padding:10px 20px 16px;border-top:1px solid rgba(0,212,255,0.08);">
        <div style="font-size:0.45rem;letter-spacing:0.15em;color:rgba(0,212,255,0.2);line-height:1.8;">
          SAY: "remind me in 10 minutes to call John"<br>
          SAY: "remind me to call John in 10 minutes"<br>
          SAY: "cancel last reminder" / "cancel all reminders"<br>
          PRESS <span style="color:rgba(0,212,255,0.4);">R</span> TO OPEN / CLOSE THIS PANEL
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const btn = document.getElementById('rem-add-btn');
    if (btn) {
      btn.addEventListener('mouseenter', () => btn.style.background = 'rgba(0,212,255,0.14)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'rgba(0,212,255,0.08)');
      btn.addEventListener('click', () => {
        const labelEl = document.getElementById('rem-input-label');
        const minsEl  = document.getElementById('rem-input-mins');
        const label   = (labelEl?.value || '').trim();
        const mins    = parseInt(minsEl?.value, 10);
        if (!label) { labelEl?.focus(); return; }
        if (!mins || mins < 1) { minsEl?.focus(); return; }
        addReminder(mins, label);
        if (labelEl) labelEl.value = '';
        if (minsEl)  minsEl.value  = '';
        if (typeof window.speak === 'function')
          window.speak(`Reminder set. I'll alert you in ${mins} minute${mins !== 1 ? 's' : ''}.`);
      });
    }
  }

  function renderPanel() {
    const list = document.getElementById('rem-list');
    if (!list) return;
    const pending = reminders.filter(r => !r.fired);
    const fired   = reminders.filter(r => r.fired).slice(-5).reverse();

    if (!pending.length && !fired.length) {
      list.innerHTML = `<div style="font-size:0.58rem;letter-spacing:0.15em;color:rgba(0,212,255,0.2);margin-top:20px;text-align:center;line-height:2;">NO REMINDERS SET<br><span style="font-size:0.48rem;">Use your voice or the form above.</span></div>`;
      return;
    }

    const iS = `background:rgba(0,212,255,0.04);border:1px solid rgba(0,212,255,0.1);border-radius:2px;padding:10px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;`;
    let html = '';

    if (pending.length) {
      html += `<div style="font-size:0.45rem;letter-spacing:0.25em;color:rgba(0,212,255,0.3);margin-bottom:8px;margin-top:4px;">PENDING</div>`;
      pending.forEach(r => {
        const tl = Math.max(0, r.triggerAt - Date.now());
        const ml = Math.ceil(tl / 60000);
        const d  = tl < 60000 ? `${Math.ceil(tl/1000)}s` : ml < 60 ? `${ml}m` : `${Math.floor(ml/60)}h ${ml%60}m`;
        html += `
          <div style="${iS}">
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.62rem;color:var(--cyan,#00d4ff);letter-spacing:0.05em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.label}</div>
              <div style="font-size:0.48rem;letter-spacing:0.12em;color:rgba(0,212,255,0.35);margin-top:3px;">AT ${fmtTime(r.triggerAt)} — IN ${d}</div>
            </div>
            <button onclick="window.kairosReminders._cancel('${r.id}')"
                    style="background:none;border:1px solid rgba(0,212,255,0.15);color:rgba(0,212,255,0.35);font-size:0.7rem;cursor:pointer;padding:2px 7px;flex-shrink:0;transition:color 0.2s;border-radius:2px;"
                    onmouseenter="this.style.color='#00d4ff'" onmouseleave="this.style.color='rgba(0,212,255,0.35)'">✕</button>
          </div>`;
      });
    }
    if (fired.length) {
      html += `<div style="font-size:0.45rem;letter-spacing:0.25em;color:rgba(0,212,255,0.18);margin-top:14px;margin-bottom:8px;">FIRED</div>`;
      fired.forEach(r => {
        html += `
          <div style="${iS}opacity:0.45;">
            <div style="flex:1;min-width:0;">
              <div style="font-size:0.58rem;color:rgba(0,212,255,0.5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${r.label}</div>
              <div style="font-size:0.45rem;letter-spacing:0.12em;color:rgba(0,212,255,0.25);margin-top:3px;">FIRED AT ${fmtTime(r.triggerAt)}</div>
            </div>
          </div>`;
      });
    }
    list.innerHTML = html;
    if (panelOpen && pending.length) {
      clearTimeout(list._refreshTimer);
      list._refreshTimer = setTimeout(renderPanel, 1000);
    }
  }

  function togglePanel() {
    ensurePanel();
    const panel = document.getElementById('rem-panel');
    if (!panel) return;
    panelOpen = !panelOpen;
    panel.style.right = panelOpen ? '0' : '-360px';
    const btn = document.getElementById('rem-btn');
    if (btn) btn.classList.toggle('active', panelOpen);
    if (panelOpen) renderPanel();
  }

  function cancelById(id) {
    const r = reminders.find(r => r.id === id);
    if (r) {
      r.fired = true; save(); renderPanel();
      if (typeof window.speak === 'function') window.speak(`Reminder cancelled: ${r.label}.`);
    }
  }

  function handleVoice(text) {
    const lower = text.toLowerCase();
    if ((lower.includes('cancel') || lower.includes('delete') || lower.includes('remove'))
        && (lower.includes('reminder') || lower.includes('remind'))) {
      return cancelReminder(lower);
    }
    if (['show reminders','list reminders','my reminders','what reminders','open reminders','show reminder','reminder list'].some(p => lower.includes(p))) {
      togglePanel();
      const pending = reminders.filter(r => !r.fired);
      if (!pending.length) return 'You have no active reminders.';
      const summary = pending.map(r => `${r.label} at ${fmtTime(r.triggerAt)}`).join(', ');
      return `You have ${pending.length} reminder${pending.length !== 1 ? 's' : ''}: ${summary}.`;
    }
    const parsed = parseReminderCommand(text);
    if (!parsed) return null;
    const { minutes, label } = parsed;
    addReminder(minutes, label);
    const timeStr = minutes < 1 ? `${Math.round(minutes * 60)} seconds` : minutes < 60 ? `${Math.round(minutes)} minute${Math.round(minutes) !== 1 ? 's' : ''}` : `${(minutes / 60).toFixed(1)} hours`;
    return `Got it. I'll remind you in ${timeStr}: "${label}".`;
  }

  function init() {
    load();
    tickInterval = setInterval(tick, 1000);
    ensurePanel();
    function wireBtn() {
      const hudBtn = document.getElementById('rem-btn');
      if (hudBtn && !hudBtn._remWired) { hudBtn.addEventListener('click', togglePanel); hudBtn._remWired = true; }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireBtn);
    else wireBtn();
  }

  window.kairosReminders = { init, handleVoice, togglePanel, addReminder, _cancel: cancelById };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();


// ════════════════════════════════════════
//  AI MODULE
//  File context injected via filereader.js
//  Memory context injected via memory.js
//  Language patched via multilang.js
// ════════════════════════════════════════
window.askKairosVision = async function (imageB64, prompt) {
  const res = await fetch("https://kairos-oabh.onrender.com/vision", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageB64, question: prompt })
  });
  const data = await res.json();
  return data.reply;
};

window.askKairosScreen = async function (imageB64, prompt) {
  const res = await fetch("https://kairos-oabh.onrender.com/screen", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ image: imageB64, question: prompt })
  });
  const data = await res.json();
  return data.reply;
};