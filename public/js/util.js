export const $ = (id) => document.getElementById(id);

/** fetch wrapper for the REST API: throws Error(message) on non-2xx. */
export async function api(path, { method = 'POST', json, text, query } = {}) {
  const url = new URL(`/api${path}`, location.origin);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const init = { method, headers: {} };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  } else if (text !== undefined) {
    init.headers['Content-Type'] = 'text/plain';
    init.body = text;
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch {
    throw new Error('Server unreachable');
  }
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return body;
}

export function toast(message, { error = false, ms = 4000 } = {}) {
  const el = document.createElement('div');
  el.className = `toast${error ? ' error' : ''}`;
  el.textContent = message;
  $('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

/** Run an async UI action, reporting failures as a toast. */
export async function attempt(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message, { error: true });
    return undefined;
  }
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
}

export const fmt = (n, digits = 2) => (Number.isFinite(n) ? n.toFixed(digits) : '—');
