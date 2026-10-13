// Modal dialogs, context menus and toasts.
import { h, $ } from './util.js';
import { icon } from './icons.js';

/**
 * Open a modal. buttons: [{label, value, primary, danger}]. Resolves with the clicked button's value
 * (after validate() passes) or null when dismissed.
 */
export function modal({ title, body, buttons = [{ label: 'OK', value: true, primary: true }], wide = false,
  validate = null, onOpen = null, dismissable = true, enterSubmits = true, size = '' }) {
  return new Promise(resolve => {
    const err = h('div', { class: 'err', role: 'alert' });
    const prev = document.activeElement;
    const close = v => {
      back.remove();
      document.removeEventListener('keydown', onKey, true);
      prev?.focus?.();
      resolve(v);
    };
    const choose = async b => {
      if (b.value !== null && b.value !== false && validate) {
        const msg = await validate(b.value);
        if (msg) { err.textContent = msg; return; }
      }
      close(b.value);
    };
    const btns = buttons.map(b => h('button', {
      class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger solid' : ''}`, type: 'button',
      onclick: () => choose(b),
    }, b.label));
    const box = h('div', { class: `modal${wide ? ' wide' : ''}${size ? ` ${size}` : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', null, title),
      h('div', { class: 'mbody' }, body, err),
      buttons.length ? h('footer', null, btns) : null);
    const back = h('div', { class: 'modal-back', onmousedown: e => { if (e.target === back && dismissable) close(null); } }, box);
    const onKey = e => {
      if (e.key === 'Escape' && dismissable) { e.preventDefault(); e.stopPropagation(); close(null); }
      else if (e.key === 'Enter' && enterSubmits && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
        const p = buttons.find(b => b.primary);
        if (p) { e.preventDefault(); e.stopPropagation(); choose(p); }
      }
      e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(back);
    draggable(box, box.querySelector('header'));
    const first = box.querySelector('input, select, textarea') || btns.find((b, i) => buttons[i].primary) || btns[0];
    first?.focus();
    if (first?.select && first.type === 'text') first.select();
    onOpen?.({ close, box });
    modal._close = close;
  });
}

/** Drag a window around by its title bar; it always keeps at least part of the title bar on screen. */
function draggable(box, handle) {
  if (!handle) return;
  let dx = 0, dy = 0;
  handle.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { handle.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    const sx = e.clientX - dx, sy = e.clientY - dy;
    const r0 = box.getBoundingClientRect();
    const baseL = r0.left - dx, baseT = r0.top - dy;
    const move = ev => {
      // keep 60 px of the title bar reachable on every side
      dx = Math.min(Math.max(ev.clientX - sx, 60 - baseL - r0.width), innerWidth - 60 - baseL);
      dy = Math.min(Math.max(ev.clientY - sy, -baseT), innerHeight - 40 - baseT);
      box.style.translate = `${dx}px ${dy}px`;
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      handle.classList.remove('dragging');
    };
    handle.classList.add('dragging');
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

export async function promptText(title, label, value = '', { placeholder = '', okLabel = 'OK', required = true } = {}) {
  const input = h('input', { type: 'text', value, placeholder });
  const r = await modal({
    title,
    body: h('div', { class: 'field' }, h('label', null, label), input),
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: true, primary: true }],
    validate: () => (required && !input.value.trim() ? 'Please enter a value.' : null),
  });
  return r ? input.value.trim() : null;
}

export async function confirmBox(title, message, { okLabel = 'OK', danger = false } = {}) {
  const r = await modal({
    title,
    body: h('p', { style: { margin: 0 } }, message),
    buttons: [{ label: 'Cancel', value: null }, { label: okLabel, value: true, primary: !danger, danger }],
  });
  return !!r;
}

/** Non-dismissable progress dialog. Returns {set(fraction|null, text), close()} */
export function progressBox(title) {
  const bar = h('div');
  const prog = h('div', { class: 'progress indeterminate' }, bar);
  const text = h('div', { class: 'note' }, 'Starting...');
  let closer = null;
  modal({ title, body: h('div', { class: 'field' }, prog, text), buttons: [], dismissable: false, onOpen: ({ close }) => { closer = close; } });
  return {
    set(fraction, msg) {
      if (fraction == null) prog.classList.add('indeterminate');
      else { prog.classList.remove('indeterminate'); bar.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`; }
      if (msg != null) text.textContent = msg;
    },
    close() { closer?.(null); },
  };
}

// ---- context menu ------------------------------------------------------------------------------------
let menuCleanup = null;

/** items: [{label, icon, kbd, danger, action}] or 'sep'. Opens at (x, y). */
export function openMenu(x, y, items) {
  closeMenu();
  const menu = $('#menu');
  menu.replaceChildren(...items.filter(Boolean).map(it => (it === 'sep' ? h('hr') : h('button', {
    class: it.danger ? 'danger' : '', type: 'button', role: 'menuitem', disabled: it.disabled || false,
    onclick: () => { closeMenu(); it.action(); },
    html: `${it.icon ? icon(it.icon) : '<span style="width:16px"></span>'}<span>${escapeHtml(it.label)}</span>${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''}`,
  }))));
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 6)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 6)}px`;
  menu.querySelector('button')?.focus();
  const onDown = e => { if (!menu.contains(e.target)) closeMenu(); };
  const onKey = e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const b = [...menu.querySelectorAll('button:not(:disabled)')];
      const i = b.indexOf(document.activeElement);
      b[(i + (e.key === 'ArrowDown' ? 1 : -1) + b.length) % b.length]?.focus();
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', closeMenu);
  });
  menuCleanup = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('blur', closeMenu);
  };
}

export function closeMenu() {
  const menu = $('#menu');
  if (menu) menu.hidden = true;
  menuCleanup?.();
  menuCleanup = null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- toasts ------------------------------------------------------------------------------------------
export function toast(msg, kind = '') {
  const t = h('div', { class: `toast ${kind}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 2800);
}
