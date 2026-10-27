// Ctrl+K command palette.
import { h } from './util.js';
import { modal } from './dialogs.js';

export function openPalette(commands) {
  const input = h('input', { type: 'search', placeholder: 'Type a command...', autocomplete: 'off' });
  const list = h('div', { class: 'palette-list' });
  let close = null;
  let shown = commands;
  let active = 0;

  const run = c => { close?.(null); c.action(); };
  const draw = () => {
    const q = input.value.trim().toLowerCase();
    shown = commands.filter(c => !q || (c.label + ' ' + (c.hint || '')).toLowerCase().includes(q));
    active = Math.min(active, Math.max(0, shown.length - 1));
    list.replaceChildren(...shown.map((c, i) => h('button', {
      class: 'palette-item' + (i === active ? ' on' : ''), type: 'button',
      onclick: () => run(c),
      onmouseenter: () => { active = i; draw(); },
    }, h('span', null, c.label), c.hint ? h('span', { class: 'hint' }, c.hint) : null)));
    if (!shown.length) list.replaceChildren(h('div', { class: 'empty-note' }, 'No matching command.'));
  };
  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, shown.length - 1); draw(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); draw(); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); if (shown[active]) run(shown[active]); }
  });
  draw();
  modal({
    title: 'Commands',
    size: 'wide',
    body: h('div', { class: 'rev-compare' }, input, list,
      h('div', { class: 'hint' }, 'Ctrl+K opens this palette. Esc closes it.')),
    buttons: [{ label: 'Close', value: null }],
    onOpen: ({ close: c }) => { close = c; setTimeout(() => input.focus(), 30); },
  });
}
