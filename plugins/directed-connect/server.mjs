// Directed Games Account connection: 1-click localhost handshake + manual code fallback,
// scoped EditorKey stored exclusively in the OS vault (never in project folders or browser).
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

const STATE_TTL_MS = 10 * 60 * 1000;
const refuse = (code, text) => { throw Object.assign(new Error(text), { code }); };

function normalizeSite(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch { refuse(400, 'site: enter a valid https:// URL'); }
  const isLocal = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLocal)) {
    refuse(400, 'site: must use https:// (or http://127.0.0.1 for local dev)');
  }
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function parseToken(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!obj || typeof obj.site !== 'string' || typeof obj.login !== 'string' || typeof obj.key !== 'string') return null;
    if (!obj.login.trim() || !obj.key.trim()) return null;
    return { site: normalizeSite(obj.site), login: obj.login.trim(), key: obj.key.trim() };
  } catch {
    return null;
  }
}

function authHeader(creds) {
  return `Basic ${Buffer.from(`${creds.login}:${creds.key}`, 'utf8').toString('base64')}`;
}

export function activate(api) {
  const pendingStates = new Map(); // state => expiresAt
  const fetchFn = api.fetch || fetch;

  const pruneStates = () => {
    const now = Date.now();
    for (const [s, exp] of pendingStates) if (exp < now) pendingStates.delete(s);
  };

  const configuredSite = () => {
    try { return normalizeSite(api.settings.get('siteUrl') || 'https://directedgames.com'); } catch { return 'https://directedgames.com'; }
  };

  async function requestJson(creds, path, { method = 'GET', body = undefined } = {}) {
    const headers = { Accept: 'application/json', 'User-Agent': 'NFGames-Map-Editor/1.0' };
    if (creds) headers.Authorization = authHeader(creds);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetchFn(`${creds ? creds.site : configuredSite()}/wp-json/directed/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) refuse(res.status >= 400 && res.status < 500 ? res.status : 502, data.message || data.error || `Directed API returned HTTP ${res.status}`);
    return data;
  }

  async function requestBinary(creds, path) {
    const headers = { 'User-Agent': 'NFGames-Map-Editor/1.0' };
    if (creds) headers.Authorization = authHeader(creds);
    const res = await fetchFn(`${creds.site}/wp-json/directed/v1${path}`, { headers });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      refuse(res.status >= 400 && res.status < 500 ? res.status : 502, err.message || `Download failed (HTTP ${res.status})`);
    }
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') || 'application/octet-stream',
    };
  }

  async function verifyAndSave(creds) {
    const me = await requestJson(creds, '/editor/me');
    api.services.setSecret('account', 'DIRECTED_TOKEN', JSON.stringify(creds));
    api.events.emit('changed', { connected: true, site: creds.site, user: me.user });
    return { connected: true, site: creds.site, ...me };
  }

  // ---- HTTP routes for the editor workbench & localhost connect callback ----

  api.routes.post('/begin', ({ body = {} }) => {
    pruneStates();
    const site = body.site ? normalizeSite(body.site) : configuredSite();
    const state = randomBytes(18).toString('base64url');
    pendingStates.set(state, Date.now() + STATE_TTL_MS);
    const port = api.server?.port || 8793;
    const device = `NFGames Map Editor (${hostname()})`.slice(0, 60);
    const params = new URLSearchParams({
      app: 'nfgames-map-editor',
      port: String(port),
      state,
      device,
    });
    return { url: `${site}/account/connect/?${params.toString()}`, state, site };
  });

  api.routes.post('/callback', async ({ body = {} }) => {
    pruneStates();
    const state = String(body.state || '');
    if (!state || !pendingStates.has(state)) {
      refuse(400, 'Connection state expired or invalid. Start again from NFGames Map Editor.');
    }
    pendingStates.delete(state);
    const creds = parseToken({ site: body.site, login: body.login, key: body.key });
    if (!creds) refuse(400, 'Incomplete credentials from Directed callback.');
    return verifyAndSave(creds);
  });

  api.routes.post('/manual', async ({ body = {} }) => {
    const creds = parseToken(body.code ?? body);
    if (!creds) refuse(400, 'Paste the full JSON connection code from directedgames.com/account/connect/.');
    return verifyAndSave(creds);
  });

  api.routes.post('/disconnect', () => {
    api.services.clearSecret('account');
    api.events.emit('changed', { connected: false });
    return { connected: false };
  });

  api.routes.get('/status', async () => {
    if (!api.services.isConnected('account')) {
      return { connected: false, site: configuredSite() };
    }
    try {
      const info = await api.services.call('nfgames.directed-connect/account', 'status', {});
      return { connected: true, ...info };
    } catch (e) {
      return { connected: false, site: configuredSite(), error: e.message };
    }
  });

  // ---- Scoped service actions (reads secret from OS vault; never exposed to page) ----

  const requireCreds = (secret) => {
    const creds = parseToken(secret('DIRECTED_TOKEN'));
    if (!creds) refuse(401, 'Not connected to Directed Games. Click Connect Directed in the status bar.');
    return creds;
  };

  api.services.provide('account', 'status', async (_input, { secret }) => {
    const creds = requireCreds(secret);
    const me = await requestJson(creds, '/editor/me');
    return { site: creds.site, ...me, cost: 0 };
  });

  api.services.provide('account', 'listMeshes', async (input = {}, { secret }) => {
    const creds = parseToken(secret('DIRECTED_TOKEN'));
    const qs = new URLSearchParams();
    for (const k of ['q', 'category', 'license', 'provenance', 'sort', 'page', 'per_page']) {
      if (input[k] !== undefined && input[k] !== '' && input[k] !== null) qs.set(k, String(input[k]));
    }
    if (input.quads) qs.set('quads', '1');
    if (input.mine) {
      if (!creds) refuse(401, 'Connect your Directed account to view your submissions.');
      qs.set('mine', '1');
    }
    const query = qs.toString() ? `?${qs.toString()}` : '';
    const data = await requestJson(creds, `/meshes${query}`);
    return { ...data, site: creds ? creds.site : configuredSite(), cost: 0 };
  });

  api.services.provide('account', 'getMesh', async (input = {}, { secret }) => {
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) refuse(400, 'mesh id required');
    const creds = parseToken(secret('DIRECTED_TOKEN'));
    const mesh = await requestJson(creds, `/meshes/${id}`);
    return { mesh, cost: 0 };
  });

  api.services.provide('account', 'uploadMesh', async (input = {}, { secret }) => {
    const creds = requireCreds(secret);
    if (!input.glb_base64 || typeof input.glb_base64 !== 'string') refuse(400, 'glb_base64 required');
    const mesh = await requestJson(creds, '/meshes', { method: 'POST', body: input });
    return { mesh, cost: 0 };
  });

  api.services.provide('account', 'downloadMesh', async (input = {}, { secret }) => {
    const id = Number(input.id);
    if (!Number.isInteger(id) || id <= 0) refuse(400, 'mesh id required');
    const creds = requireCreds(secret);
    const mesh = await requestJson(creds, `/meshes/${id}`);
    const bin = await requestBinary(creds, `/meshes/${id}/download`);
    return { mesh, glb_base64: bin.buffer.toString('base64'), cost: 0 };
  });

  api.services.provide('account', 'downloadRef', async (input = {}, { secret }) => {
    const id = Number(input.id);
    const name = String(input.name || '');
    if (!Number.isInteger(id) || id <= 0 || !/^[a-zA-Z0-9._-]+$/.test(name)) refuse(400, 'valid mesh id and ref name required');
    const creds = requireCreds(secret);
    const bin = await requestBinary(creds, `/meshes/${id}/refs/${encodeURIComponent(name)}`);
    return { name, data_base64: bin.buffer.toString('base64'), contentType: bin.contentType, cost: 0 };
  });
}
