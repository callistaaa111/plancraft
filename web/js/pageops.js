// Page operations: crop an area into a new page, and copy / paste pages (also between projects).
import { S, ix, emit, mutate, pageById, setPage, setTool, PALETTE } from './store.js';
import * as M from './measure.js';
import * as api from './api.js';
import { h, uid, fmt } from './util.js';
import { modal, toast } from './dialogs.js';

const CLIP_KEY = 'plancraft.clipboard';
let memoryClip = null;   // used when browser storage is unavailable

function insertPage(page, afterId) {
  const pages = S.project.pages;
  const i = pages.findIndex(p => p.id === afterId);
  pages.splice(i < 0 ? pages.length : i + 1, 0, page);
}

// ---- crop ------------------------------------------------------------------------------------------
/** rect = {x, y, w, h} in page pixels. Resolves true when a page was made. */
export async function cropToNewPage(page, rect) {
  const units = S.project.units;
  const u = M.UNITS[units];
  const wm = M.lengthOf(rect.w, page, units), hm = M.lengthOf(rect.h, page, units);
  const name = h('input', { type: 'text', value: `${page.name} (crop)` });
  const ok = await modal({
    title: 'New page from this area',
    body: [
      h('div', { class: 'field' }, h('label', null, 'Page name'), name),
      h('p', { class: 'note', style: { margin: 0 } },
        `${Math.round(rect.w)} x ${Math.round(rect.h)} px${wm != null ? ` (about ${fmt(wm)} x ${fmt(hm)} ${u.len})` : ''}. `,
        M.pxPerM(page) ? 'The new page keeps this page\'s scale. ' : '',
        'Takeoff is not copied, so nothing is counted twice.'),
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Create page', value: true, primary: true }],
    validate: () => (name.value.trim() ? null : 'Give the page a name.'),
  });
  if (!ok) return false;
  const pid = S.project.id;
  let res;
  try {
    res = await api.cropPage(pid, page.image, [rect.x, rect.y, rect.w, rect.h]);
  } catch (err) { toast(err.message, 'error'); return false; }
  if (S.project?.id !== pid) return false;
  const src = pageById(page.id) || page;
  const np = {
    id: res.id, name: name.value.trim(), image: res.image, width: res.width, height: res.height, dpi: src.dpi ?? null,
    scale: src.scale ? { ...src.scale } : null, source: src.source, sourcePage: src.sourcePage, group: src.group,
    cropOf: { page: src.id, rect: [res.offset[0], res.offset[1], res.width, res.height] },
  };
  mutate(() => insertPage(np, src.id));
  setTool('select');
  setPage(np.id);
  toast(`Created page "${np.name}".`);
  return true;
}

// ---- copy & paste ----------------------------------------------------------------------------------
function readClip() {
  try {
    const raw = localStorage.getItem(CLIP_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* storage unavailable */ }
  return memoryClip;
}

export const hasClip = () => !!readClip()?.page;

/** Copy a page (and the takeoff on it, for pasting with takeoff). */
export function copyPage(pageId) {
  const page = pageById(pageId);
  if (!page) return;
  const x = ix();
  const items = [];
  for (const it of x.items) {
    const secs = it.sections.filter(s => s.page === page.id);
    if (!secs.length) continue;
    const path = [];
    for (let p = x.nodes.get(it.id)?.parent; p; p = x.nodes.get(p.id)?.parent) path.unshift(p.name);
    items.push({
      id: it.id, name: it.name, type: it.type, color: it.color, props: it.props, path,
      sections: secs.map(s => ({ points: s.points, ...(s.deduct ? { deduct: true } : {}) })),
    });
  }
  const { id, ...meta } = page;
  const clip = { v: 1, projectId: S.project.id, projectName: S.project.name, page: { ...meta, oldId: id }, items };
  memoryClip = clip;
  try { localStorage.setItem(CLIP_KEY, JSON.stringify(clip)); } catch { /* too big or unavailable: memory copy still works */ }
  emit('clip');
  toast(`Copied page "${page.name}". Paste it with Ctrl+V, here or in another project.`);
}

/** Paste the copied page after the open page. */
export async function pastePage() {
  if (!S.project) return;
  const clip = readClip();
  if (!clip?.page) { toast('Copy a page first (right-click a page > Copy page, or Ctrl+C).'); return; }
  const same = clip.projectId === S.project.id;
  const nSecs = clip.items.reduce((a, i) => a + i.sections.length, 0);
  const name = h('input', { type: 'text', value: same ? `${clip.page.name} (copy)` : clip.page.name });
  const takeoffRadio = h('input', { type: 'radio', name: 'pasteWhat', value: 'takeoff' });
  const opts = [
    h('label', null, h('input', { type: 'radio', name: 'pasteWhat', value: 'page', checked: true }), 'Page only (blank, for a new takeoff)'),
    nSecs ? h('label', null, takeoffRadio,
      `Page with its takeoff (${nSecs} section${nSecs === 1 ? '' : 's'} in ${clip.items.length} item${clip.items.length === 1 ? '' : 's'})`) : null,
  ];
  const ok = await modal({
    title: `Paste page "${clip.page.name}"`,
    body: [
      h('div', { class: 'field' }, h('label', null, 'Page name'), name),
      nSecs ? h('div', { class: 'field' }, h('div', { class: 'label' }, 'What to paste'), h('div', { class: 'radio-list' }, opts),
        h('div', { class: 'hint' }, same
          ? 'Pasted takeoff counts again in the same items (handy for typical floors).'
          : `Takeoff goes into items with the same name here; missing items are created. Copied from "${clip.projectName}".`)) : null,
    ],
    buttons: [{ label: 'Cancel', value: null }, { label: 'Paste', value: true, primary: true }],
    validate: () => (name.value.trim() ? null : 'Give the page a name.'),
  });
  if (!ok) return;
  await doPaste(clip, name.value.trim(), nSecs > 0 && takeoffRadio.checked);
}

async function doPaste(clip, name, withTakeoff) {
  const pid = S.project.id;
  let res;
  try {
    res = await api.copyPageImage(pid, clip.projectId, clip.page.image);
  } catch (err) { toast(err.message, 'error'); return; }
  if (S.project?.id !== pid) return;
  const { oldId, ...meta } = clip.page;
  const np = { ...meta, id: res.id, name, image: res.image, width: res.width, height: res.height,
    scale: meta.scale ? { ...meta.scale } : null };
  const after = S.pageId;
  let created = 0;
  mutate(p => {
    insertPage(np, after);
    if (!withTakeoff) return;
    const x = ix();
    for (const ci of clip.items) {
      let target = clip.projectId === p.id ? x.nodes.get(ci.id)?.node : null;
      if (target && (target.kind !== 'item' || target.type !== ci.type)) target = null;
      if (!target) target = findItem(x, ci);
      if (!target) {
        target = {
          id: uid('i'), kind: 'item', type: ci.type, name: ci.name, color: ci.color || PALETTE[created % PALETTE.length],
          visible: true, props: JSON.parse(JSON.stringify(ci.props || {})), sections: [],
        };
        folderList(p, ci.path).push(target);
        created++;
      }
      for (const s of ci.sections) {
        target.sections.push({ id: uid('s'), page: np.id, points: s.points.map(q => q.slice()), ...(s.deduct ? { deduct: true } : {}) });
      }
    }
  });
  setPage(np.id);
  toast(`Pasted page "${name}"${withTakeoff ? ` with its takeoff${created ? ` (${created} new item${created === 1 ? '' : 's'})` : ''}` : ''}.`);
}

/** Same name and type, preferring the same folder path. */
function findItem(x, ci) {
  const matches = x.items.filter(i => i.type === ci.type && i.name === ci.name);
  if (matches.length <= 1) return matches[0] || null;
  const pathOf = it => {
    const path = [];
    for (let p = x.nodes.get(it.id)?.parent; p; p = x.nodes.get(p.id)?.parent) path.unshift(p.name);
    return path.join('/');
  };
  return matches.find(m => pathOf(m) === (ci.path || []).join('/')) || matches[0];
}

/** The children list of the folder at path (creating folders as needed). */
function folderList(project, path) {
  let list = project.tree;
  for (const name of path || []) {
    let f = list.find(n => n.kind === 'folder' && n.name === name);
    if (!f) {
      f = { id: uid('f'), kind: 'folder', name, open: true, visible: true, children: [] };
      list.push(f);
    }
    list = f.children;
  }
  return list;
}
