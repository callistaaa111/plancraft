// Copy/paste a takeoff item or folder, including its sections when the target project has matching pages.
import { S, nodeById, mutate, uid } from './store.js';
import { toast } from './dialogs.js';

const KEY = 'plancraft.itemclip';
let memory = null;

function read() {
  try { const raw = localStorage.getItem(KEY); if (raw) return JSON.parse(raw); } catch { /* storage unavailable */ }
  return memory;
}

function pageMeta(pageId) {
  const p = S.project.pages.find(x => x.id === pageId);
  return p ? { name: p.name, source: p.source, sourcePage: p.sourcePage } : null;
}

function serialize(node) {
  if (node.kind === 'folder') {
    return { kind: 'folder', name: node.name, open: node.open, visible: node.visible, assembly: node.assembly,
      children: (node.children || []).map(serialize) };
  }
  return { kind: 'item', type: node.type, name: node.name, color: node.color, visible: node.visible,
    props: JSON.parse(JSON.stringify(node.props || {})),
    sections: (node.sections || []).map(s => ({ points: s.points, deduct: !!s.deduct, page: pageMeta(s.page) })) };
}

function findParent(nodes, id, parent = null) {
  for (const n of nodes || []) {
    if (n.id === id) return { parent, list: nodes };
    if (n.children) { const hit = findParent(n.children, id, n); if (hit) return hit; }
  }
  return null;
}

function targetPage(meta) {
  if (!meta) return null;
  const pages = S.project.pages;
  return (pages.find(p => meta.source && p.source === meta.source && p.sourcePage === meta.sourcePage)
    || pages.find(p => meta.name && p.name === meta.name))?.id || null;
}

function cloneNode(src, pages) {
  if (src.kind === 'folder') {
    return { id: uid('f'), kind: 'folder', name: src.name, open: src.open !== false, visible: src.visible !== false,
      assembly: src.assembly || null, children: (src.children || []).map(c => cloneNode(c, pages)) };
  }
  const sections = [];
  for (const s of src.sections || []) {
    const page = targetPage(s.page);
    if (page) sections.push({ id: uid('s'), page, points: s.points, ...(s.deduct ? { deduct: true } : {}) });
    else pages.missing++;
  }
  return { id: uid('i'), kind: 'item', type: src.type, name: src.name, color: src.color,
    visible: src.visible !== false, props: JSON.parse(JSON.stringify(src.props || {})), sections };
}

export function hasNodeClip() {
  const c = read();
  return !!(c && c.nodes && c.nodes.length);
}

export function copyNode(id) {
  const node = nodeById(id);
  if (!node) return;
  const clip = { projectId: S.project.id, nodes: [serialize(node)] };
  memory = clip;
  try { localStorage.setItem(KEY, JSON.stringify(clip)); } catch { /* memory copy still works */ }
  toast(`Copied "${node.name}". Paste it here or in another project.`);
}

export function pasteNode(atId = null) {
  const clip = read();
  if (!clip?.nodes?.length) return;
  const pages = { missing: 0 };
  const nodes = clip.nodes.map(n => cloneNode(n, pages));
  mutate(() => {
    const target = atId ? nodeById(atId) : null;
    if (target?.kind === 'folder') {
      target.children = target.children || [];
      target.children.push(...nodes);
      return;
    }
    if (target) {
      const hit = findParent(S.project.tree, target.id);
      if (hit) { hit.list.splice(hit.list.indexOf(target) + 1, 0, ...nodes); return; }
    }
    S.project.tree.push(...nodes);
  });
  toast(pages.missing ? `Pasted; ${pages.missing} section(s) had no matching page in this project.` : 'Pasted.');
}
