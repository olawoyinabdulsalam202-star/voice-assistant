/* ============================================================
   KAIROS — custom dropdown  (kx-select)
   ------------------------------------------------------------
   Progressive enhancement over the native <select>. The native
   element stays in the DOM as the single source of truth — its
   id, name, .value, .options and change/input events are all
   preserved — so no page JS has to change. We only replace the
   visual control and, on desktop, the OS-drawn option popup
   (which ignores CSS — the "default google dropdown") with a
   styled listbox.

   Touch devices are left alone: the native mobile picker is a
   good wheel UI and the closed control is already styled by
   components.css. The desktop popup is the thing the design
   could not reach, so that is the only thing we take over.

   The open menu is portalled to <body> so it is never clipped
   by an ancestor's overflow:hidden (admin .section, drawers),
   and it is removed again on close so nothing leaks when a
   container re-renders its innerHTML (user drawer, persona).
   ============================================================ */
(function () {
  'use strict';

  // Only take over where the OS popup is the problem — a fine pointer
  // with hover. Touch keeps the native picker.
  const DESKTOP = !!(window.matchMedia &&
    window.matchMedia('(hover: hover) and (pointer: fine)').matches);
  if (!DESKTOP) return;

  const CHEVRON =
    '<svg viewBox="0 0 12 8" width="12" height="8" fill="none" ' +
    'stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ' +
    'stroke-linejoin="round" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5"/></svg>';

  let open = null; // the currently-open instance, or null

  function enhance(sel) {
    if (!sel || sel.dataset.kxSelect || sel.multiple || sel.size > 1) return;
    sel.dataset.kxSelect = '1';

    const wrap = document.createElement('div');
    wrap.className = 'kx-select';
    // Mirror the select's intended width so page layout is unchanged.
    const w = sel.style.width;
    if (w) wrap.style.width = w;
    else if (sel.classList.contains('glass-input')) wrap.style.width = '100%';

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.classList.add('kx-select__native');

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'kx-select__button';
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    if (sel.disabled) button.disabled = true;
    button.innerHTML =
      '<span class="kx-select__label"></span>' +
      '<span class="kx-select__chev">' + CHEVRON + '</span>';

    const menu = document.createElement('div');
    menu.className = 'kx-select__menu';
    menu.setAttribute('role', 'listbox');
    menu.tabIndex = -1;

    wrap.appendChild(button);

    const inst = {
      sel: sel, wrap: wrap, button: button,
      label: button.querySelector('.kx-select__label'),
      menu: menu, highlight: -1,
    };
    sel._kxInst = inst;

    button.addEventListener('mousedown', (e) => e.preventDefault());
    button.addEventListener('click', (e) => { e.preventDefault(); toggle(inst); });
    button.addEventListener('keydown', (e) => onKey(e, inst));
    // Fires for our own selection AND for any programmatic value change that
    // the page dispatches — keep the label in step either way.
    sel.addEventListener('change', () => syncLabel(inst));
    // Option lists can be rebuilt at runtime (speech-synthesis voices).
    new MutationObserver(() => {
      buildMenu(inst);
      if (open === inst) position(inst);
    }).observe(sel, { childList: true });

    buildMenu(inst);
  }

  function buildMenu(inst) {
    const frag = document.createDocumentFragment();
    Array.from(inst.sel.options).forEach((opt, i) => {
      const item = document.createElement('div');
      item.className = 'kx-select__option';
      item.setAttribute('role', 'option');
      item.dataset.index = String(i);
      item.textContent = opt.textContent;
      if (opt.disabled) item.classList.add('is-disabled');
      item.addEventListener('mousedown', (e) => {
        e.preventDefault();
        if (!opt.disabled) choose(inst, i);
      });
      item.addEventListener('mousemove', () => setHighlight(inst, i));
      frag.appendChild(item);
    });
    inst.menu.innerHTML = '';
    inst.menu.appendChild(frag);
    syncLabel(inst);
  }

  function syncLabel(inst) {
    const opt = inst.sel.options[inst.sel.selectedIndex];
    inst.label.textContent = opt ? opt.textContent : '';
    const kids = inst.menu.children;
    for (let i = 0; i < kids.length; i++) {
      const on = i === inst.sel.selectedIndex;
      kids[i].setAttribute('aria-selected', on ? 'true' : 'false');
      kids[i].classList.toggle('is-selected', on);
    }
  }

  function choose(inst, i) {
    if (inst.sel.selectedIndex !== i) {
      inst.sel.selectedIndex = i;
      inst.sel.dispatchEvent(new Event('input', { bubbles: true }));
      inst.sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    syncLabel(inst);
    close();
    inst.button.focus();
  }

  function setHighlight(inst, i) {
    inst.highlight = i;
    const kids = inst.menu.children;
    for (let k = 0; k < kids.length; k++) kids[k].classList.toggle('is-active', k === i);
  }

  function position(inst) {
    const r = inst.button.getBoundingClientRect();
    const menu = inst.menu;
    menu.style.minWidth = r.width + 'px';
    menu.style.left = Math.round(r.left) + 'px';
    const mh = menu.offsetHeight;
    const below = window.innerHeight - r.bottom;
    if (below < mh + 8 && r.top > below) {
      menu.style.top = Math.max(8, Math.round(r.top - mh - 6)) + 'px';
    } else {
      menu.style.top = Math.round(r.bottom + 6) + 'px';
    }
  }

  function toggle(inst) { (open === inst) ? close() : openMenu(inst); }

  function openMenu(inst) {
    if (open) close();
    open = inst;
    buildMenu(inst);                    // re-read (catches programmatic .value)
    document.body.appendChild(inst.menu);
    inst.wrap.classList.add('kx-select--open');
    inst.button.setAttribute('aria-expanded', 'true');
    position(inst);
    setHighlight(inst, inst.sel.selectedIndex);
    const sel = inst.menu.querySelector('.is-selected');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    if (!open) return;
    const inst = open;
    inst.wrap.classList.remove('kx-select--open');
    inst.button.setAttribute('aria-expanded', 'false');
    if (inst.menu.parentNode) inst.menu.parentNode.removeChild(inst.menu);
    inst.highlight = -1;
    open = null;
  }

  function onKey(e, inst) {
    const opts = inst.sel.options;
    const n = opts.length;
    if (!n) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (open !== inst) { openMenu(inst); return; }
      let i = inst.highlight < 0 ? inst.sel.selectedIndex : inst.highlight;
      let guard = 0;
      do {
        i = e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      } while (opts[i] && opts[i].disabled && ++guard < n);
      setHighlight(inst, i);
      if (inst.menu.children[i]) inst.menu.children[i].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (open !== inst) openMenu(inst);
      else if (inst.highlight >= 0) choose(inst, inst.highlight);
    } else if (e.key === 'Escape') {
      if (open === inst) { e.preventDefault(); close(); }
    } else if (e.key === 'Tab') {
      close();
    }
  }

  // Dismiss on outside click, scroll or resize (portalled menu can't ride along).
  document.addEventListener('mousedown', (e) => {
    if (open && !open.wrap.contains(e.target) && !open.menu.contains(e.target)) close();
  });
  window.addEventListener('resize', () => close(), true);
  window.addEventListener('scroll', () => { if (open) close(); }, true);

  function enhanceAll(root) {
    (root || document).querySelectorAll('select:not([data-kx-select])').forEach(enhance);
  }

  function init() {
    enhanceAll(document);
    // Selects created later (user drawer, device panel, persona form, voices).
    new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach((node) => {
          if (node.nodeType !== 1) return;
          if (node.tagName === 'SELECT') enhance(node);
          else if (node.querySelectorAll) enhanceAll(node);
        });
      }
    }).observe(document.documentElement, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Escape hatch for pages that build selects imperatively and want to force a pass.
  window.kairosDropdown = { enhance: enhance, enhanceAll: enhanceAll, refresh: () => enhanceAll(document) };
})();
