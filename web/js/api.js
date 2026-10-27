// Talking to the local PlanCraft server.

async function req(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Cannot reach PlanCraft. Is its window (the server) still open?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

export const ping = () => req('GET', '/api/ping');
export const listProjects = () => req('GET', '/api/projects');
export const createProject = (name, units) => req('POST', '/api/projects', { name, units });
export const getProject = id => req('GET', `/api/projects/${encodeURIComponent(id)}`);
export const saveProject = (id, project) => req('PUT', `/api/projects/${encodeURIComponent(id)}`, project);
export const deleteProject = id => req('DELETE', `/api/projects/${encodeURIComponent(id)}`);
export const listBackups = id => req('GET', `/api/projects/${encodeURIComponent(id)}/backups`);
export const restoreBackup = (id, name) => req('POST', `/api/projects/${encodeURIComponent(id)}/restore`, { name });
export const getTask = id => req('GET', `/api/tasks/${encodeURIComponent(id)}`);

export const rotatePage = (id, image, turns) => req('POST', `/api/projects/${encodeURIComponent(id)}/pages/rotate`, { image, turns });
export const cropPage = (id, image, rect) => req('POST', `/api/projects/${encodeURIComponent(id)}/pages/crop`, { image, rect });
export const copyPageImage = (id, fromProject, image) => req('POST', `/api/projects/${encodeURIComponent(id)}/pages/copy`, { fromProject, image });

export const autoCount = (id, image, rect, opts = {}) => req('POST', `/api/projects/${encodeURIComponent(id)}/autocount`, { image, rect, ...opts });
export const tintUrl = (id, image, color) => `/api/projects/${encodeURIComponent(id)}/pages/${encodeURIComponent(image)}/tint?color=${color}`;

export const pageUrl = (projectId, page) => `/api/projects/${encodeURIComponent(projectId)}/pages/${encodeURIComponent(page.image)}`;
export const exportUrl = projectId => `/api/projects/${encodeURIComponent(projectId)}/export.xlsx`;

/** Build a PlanSwift job of the project on the server, then download it. onProgress(fraction, message). */
export async function exportSwiftJob(projectId, onProgress) {
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  const { task } = await req('POST', `${base}/export.swiftjob`, {});
  const res = await waitTask(task, t => onProgress?.(t.total ? t.done / t.total : null, t.message));
  return { ...res, url: `${base}/exports/${encodeURIComponent(res.file)}?download=1` };
}

/** Save on page close; fetch() may be cancelled at that point, a beacon is not. */
export function beaconSave(id, project) {
  const blob = new Blob([JSON.stringify(project)], { type: 'application/json' });
  return navigator.sendBeacon(`/api/projects/${encodeURIComponent(id)}/save`, blob);
}

/** POST a file as the raw body, reporting upload progress (0..1). Resolves with the JSON reply. */
export function upload(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = e => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else reject(new Error(data.error || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error('Cannot reach PlanCraft. Is its window (the server) still open?'));
    xhr.send(file);
  });
}

/** Poll a background task until it finishes. onProgress(task) gets every update. */
export async function waitTask(taskId, onProgress) {
  for (;;) {
    const t = await getTask(taskId);
    onProgress?.(t);
    if (t.status === 'done') return t.result;
    if (t.status === 'error') throw new Error(t.error || 'Import failed');
    await new Promise(r => setTimeout(r, 400));
  }
}
