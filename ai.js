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
    syncFromServer(); // fire-and-forget — merges in anything saved from another device/session
  }

  async function syncFromServer() {
    try {
      const token = localStorage.getItem('kairos_token') || '';
      if (!token) return true;
      const r = await fetch('/api/reminders', { headers: { 'Authorization': `Bearer ${token}` } });
      if (!r.ok) return;
      const data = await r.json();
      (data.reminders || []).forEach(sr => {
        const already = reminders.find(r => r.serverId === sr.id);
        if (already) { already.fired = sr.fired; return; }
        reminders.push({
          id: uid(), serverId: sr.id, label: sr.text,
          triggerAt: new Date(sr.remind_at).getTime(),
          fired: sr.fired, createdAt: new Date(sr.created_at).getTime()
        });
      });
      save();
      renderPanel();
    } catch (e) { /* offline — localStorage copy still works for this session */ }
  }

  async function pushReminderToServer(reminder) {
    try {
      const token = localStorage.getItem('kairos_token') || '';
      if (!token) return;
      const res = await fetch('/api/reminders', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: reminder.label, remind_at: new Date(reminder.triggerAt).toISOString() })
      });
      if (res.ok) {
        const data = await res.json();
        reminder.serverId = data.id;
        save();
        return true;
      } else {
        const data = await res.json().catch(() => ({}));
        window.showNotification && window.showNotification(data.error || 'Reminder saved only on this device.');
        return false;
      }
    } catch (e) {
      window.showNotification && window.showNotification('Reminder could not reach the server.');
      return false;
    }
  }

  function markFiredOnServer(reminder) {
    if (!reminder.serverId) return;
    const token = localStorage.getItem('kairos_token') || '';
    if (!token) return;
    fetch(`/api/reminders/${reminder.serverId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fired: true })
    }).catch(() => {});
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
    if (minutes === null) {
      const clock = lower.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);
      if (clock) {
        let hour = Number(clock[1]);
        const minute = Number(clock[2] || 0);
        if (clock[3] === 'pm' && hour < 12) hour += 12;
        if (clock[3] === 'am' && hour === 12) hour = 0;
        if (hour < 24 && minute < 60) {
          const target = new Date();
          target.setHours(hour, minute, 0, 0);
          if (target.getTime() <= Date.now()) target.setDate(target.getDate() + 1);
          minutes = (target.getTime() - Date.now()) / 60000;
        }
      }
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

  async function addReminder(minutes, label) {
    const triggerAt = Date.now() + Math.round(minutes * 60000);
    const reminder = { id: uid(), label, triggerAt, fired: false, createdAt: Date.now() };
    const synced = await pushReminderToServer(reminder);
    if (!synced && localStorage.getItem('kairos_token')) return null;
    reminders.push(reminder);
    save(); renderPanel();
    return reminder;
  }

  async function editReminder(id) {
    const reminder = reminders.find(r => String(r.id) === String(id));
    if (!reminder) return;
    const label = prompt('Reminder text:', reminder.label);
    if (!label || !label.trim()) return;
    const currentMinutes = Math.max(1, Math.ceil((reminder.triggerAt - Date.now()) / 60000));
    const minutes = Number(prompt('Minutes from now:', currentMinutes));
    if (!Number.isFinite(minutes) || minutes < 1) return;
    reminder.label = label.trim();
    reminder.triggerAt = Date.now() + Math.round(minutes * 60000);
    reminder.fired = false;
    save();
    if (reminder.serverId) {
      await fetch(`/api/reminders/${reminder.serverId}`, {
        method: 'PATCH',
        headers: { 'Authorization': `Bearer ${localStorage.getItem('kairos_token') || ''}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: reminder.label, remind_at: new Date(reminder.triggerAt).toISOString(), fired: false })
      }).catch(() => {});
    } else {
      pushReminderToServer(reminder);
    }
    renderPanel();
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
      last.fired = true; save(); renderPanel(); markFiredOnServer(last);
      return `Cancelled reminder: "${last.label}".`;
    }
    const pending = reminders.filter(r => !r.fired);
    const words = lower.replace(/cancel|reminder|remind/g, '').trim().split(/\s+/).filter(Boolean);
    const match = pending.find(r => words.some(w => r.label.toLowerCase().includes(w)));
    if (match) { match.fired = true; save(); renderPanel(); markFiredOnServer(match); return `Cancelled reminder: "${match.label}".`; }
    return "I couldn't find a matching reminder to cancel.";
  }

  function tick() {
    const now = Date.now();
    const due = reminders.filter(r => !r.fired && r.triggerAt <= now);
    due.forEach(r => { r.fired = true; fireReminder(r); markFiredOnServer(r); });
    if (due.length) { save(); renderPanel(); }
  }

  function fireReminder(r) {
    const msg = `Reminder, ${(window.getKairosName && window.getKairosName()) || "friend"}: ${r.label}`;
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
    const card = toast.querySelector('.kx-toast');
    if (card) card.classList.add('leaving');  // fade+scale to 0.97 (Brief §5)
    toast.style.opacity = '0';                // fade out (was a translateY slide)
    toast.style.pointerEvents = 'none';
  }

  window._kairosToastDismiss = dismissToast;

  // S6: reminder labels come from speech transcripts and from the
  // manual input box, and were being written straight into innerHTML.
  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showToast(label) {
    let toast = document.getElementById('rem-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'rem-toast';
      // Redesign: fixed centering shell (no transform) so the card's
      // kx-toast-in fade+scale never fights a centering translateX.
      toast.className = 'kx-toast-wrap';
      document.body.appendChild(toast);
    }
    // Recreating the inner card re-triggers its kx-toast-in entrance (Brief §5).
    toast.innerHTML = `
      <div class="kx-toast" role="status">
        <span class="kx-toast__icon"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-bell"/></svg></span>
        <div class="kx-toast__body">
          <div class="kx-toast__title">Reminder</div>
          <div class="kx-toast__msg">${escapeHtml(label)}</div>
        </div>
        <button class="kx-toast__close kx-icon-mini" onclick="window._kairosToastDismiss()" aria-label="Dismiss reminder"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></button>
      </div>
    `;
    // clear any inline opacity/pointer-events left by a prior dismiss
    toast.style.opacity = '';
    toast.style.pointerEvents = '';
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(dismissToast, 8000);
  }

  function ensurePanel() {
    if (document.getElementById('rem-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'rem-panel';
    // B3: was a fixed 340px with no mobile rule — on a 360px phone the
    // panel covered essentially the whole screen with no way to see
    // what was behind it. min() keeps a visible edge on every device.
    panel.className = 'kx-drawer kx-drawer--right kx-panel kx-panel--right';
    panel.innerHTML = `
      <div class="kx-drawer__head">
        <span class="kx-drawer__title"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-bell"/></svg> REMINDERS</span>
        <button class="kx-icon-mini" onclick="window.kairosReminders.togglePanel()" aria-label="Close reminders panel"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-x"/></svg></button>
      </div>
      <div class="kx-drawer__section">
        <div class="kx-drawer__eyebrow"><svg class="ic ic--sm" aria-hidden="true"><use href="/icons.svg#ic-plus"/></svg> ADD MANUALLY</div>
        <div class="glass-field">
          <input id="rem-input-label" class="glass-input" placeholder="Reminder label..." />
          <div class="kx-field-row">
            <input id="rem-input-mins" class="glass-input" type="number" min="1" max="1440" placeholder="Minutes" style="flex:1;" />
            <button id="rem-add-btn" class="glass-btn glass-btn--sm">SET</button>
          </div>
        </div>
      </div>
      <div id="rem-list" class="kx-drawer__list kx-scroll"></div>
      <div class="kx-drawer__foot">
        <div class="kx-drawer__hint">
          SAY: "remind me in 10 minutes to call John"<br>
          SAY: "remind me to call John in 10 minutes"<br>
          SAY: "cancel last reminder" / "cancel all reminders"<br>
          PRESS <b>R</b> TO OPEN / CLOSE THIS PANEL
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    const btn = document.getElementById('rem-add-btn');
    if (btn) {
      btn.addEventListener('mouseenter', () => btn.style.background = 'var(--glass-fill-strong)');
      btn.addEventListener('mouseleave', () => btn.style.background = 'var(--glass-fill)');
      btn.addEventListener('click', async () => {
        const labelEl = document.getElementById('rem-input-label');
        const minsEl  = document.getElementById('rem-input-mins');
        const label   = (labelEl?.value || '').trim();
        const mins    = parseInt(minsEl?.value, 10);
        if (!label) { labelEl?.focus(); return; }
        if (!mins || mins < 1) { minsEl?.focus(); return; }
        const created = await addReminder(mins, label);
        if (!created) return;
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
      list.innerHTML = `<div class="kx-empty">NO REMINDERS SET<br><span>Use your voice or the form above.</span></div>`;
      return;
    }

    let html = '';

    if (pending.length) {
      html += `<div class="kx-drawer__eyebrow">PENDING</div>`;
      pending.forEach(r => {
        const tl = Math.max(0, r.triggerAt - Date.now());
        const ml = Math.ceil(tl / 60000);
        const d  = tl < 60000 ? `${Math.ceil(tl/1000)}s` : ml < 60 ? `${ml}m` : `${Math.floor(ml/60)}h ${ml%60}m`;
        html += `
          <div class="kx-item">
            <div class="kx-item__main">
              <div class="kx-item__value">${escapeHtml(r.label)}</div>
              <div class="kx-item__meta">AT ${fmtTime(r.triggerAt)} — IN ${d}</div>
            </div>
            <button class="kx-icon-mini" onclick="window.kairosReminders._edit('${escapeHtml(r.id)}')" aria-label="Edit reminder"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-pencil"/></svg></button>
            <button class="kx-icon-mini kx-icon-mini--danger" onclick="window.kairosReminders._cancel('${escapeHtml(r.id)}')" aria-label="Cancel reminder"><svg class="ic" aria-hidden="true"><use href="/icons.svg#ic-trash"/></svg></button>
          </div>`;
      });
    }
    if (fired.length) {
      html += `<div class="kx-drawer__eyebrow">FIRED</div>`;
      fired.forEach(r => {
        html += `
          <div class="kx-item is-fired">
            <div class="kx-item__main">
              <div class="kx-item__value">${escapeHtml(r.label)}</div>
              <div class="kx-item__meta">FIRED AT ${fmtTime(r.triggerAt)}</div>
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
    panel.classList.toggle('open', panelOpen);                  // fade+scale (was right:0 / -100% slide)
    document.body.classList.toggle('kx-panel-open', panelOpen); // dims the orb while open (Brief §5)
    const btn = document.getElementById('rem-btn');
    if (btn) btn.classList.toggle('active', panelOpen);
    if (panelOpen) renderPanel();
  }

  function cancelById(id) {
    const r = reminders.find(r => r.id === id);
    if (r) {
      r.fired = true; save(); renderPanel();
      markFiredOnServer(r);
      if (typeof window.speak === 'function') window.speak(`Reminder cancelled: ${r.label}.`);
    }
  }

  async function handleVoice(text) {
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
    const created = await addReminder(minutes, label);
    if (!created) return 'I could not set that reminder because your active reminder limit has been reached.';
    const timeStr = minutes < 1 ? `${Math.round(minutes * 60)} seconds` : minutes < 60 ? `${Math.round(minutes)} minute${Math.round(minutes) !== 1 ? 's' : ''}` : `${(minutes / 60).toFixed(1)} hours`;
    return `Got it. I'll remind you in ${timeStr}: "${label}".`;
  }

  function init() {
    load();
    tickInterval = setInterval(tick, 1000);
    ensurePanel();
    // NOTE: rem-btn's click is wired once, centrally, in index.htm's load
    // listener. Binding it again here would double-fire togglePanel() per
    // click (open then instantly close) — the same bug that broke SET/MEM.
  }

  window.kairosReminders = { init, handleVoice, togglePanel, addReminder, _cancel: cancelById, _edit: editReminder };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();


// ════════════════════════════════════════
//  AI MODULE
//
//  F6 FIX: this file used to redefine window.askKairosVision and
//  window.askKairosScreen, which brain.js also defines. Whichever
//  script loaded last silently won, and the two versions did not
//  behave the same (different error handling, different history
//  writes). They now live in brain.js only.
//
//  Context injection lives in the wrappers:
//    Filereader.js  — document text
//    Memory.js      — stored memories
//    Multilang.js   — language instruction
//  Each passes { raw, augmented } so history stays clean (see A7).
// ════════════════════════════════════════
