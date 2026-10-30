'use strict';

/**
 * ShareHTML on Catalyst AppSail.
 *
 * - Management UI (owner only, guarded by an admin passcode) at  /
 * - REST API                                                     /api/*
 * - Public share links serve the stored HTML                     /p/:id   (?v=<vid> for a version)
 *
 * Each page is stored as one JSON object in a Stratus bucket:
 *   pages/<id>.json   -> { id, title, disabled, created, updated,
 *                          versioning, live, versions:[ { vid, label, html, created, updated } ] }
 *   index.json        -> [ meta ]  (everything except each version's html, for fast listing)
 *
 * Legacy pages (created before versioning) stored { id, title, html, disabled, created, updated }.
 * They are normalized in memory into a single version with vid "v1" — never rewritten until edited.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const catalyst = require('zcatalyst-sdk-node');

const app = express();
app.use(express.json({ limit: '15mb' }));

const PORT = process.env.X_ZOHO_CATALYST_LISTEN_PORT || 9000;
const BUCKET = process.env.BUCKET_NAME || 'sharehtml-29642000000379001';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const INDEX_KEY = 'index.json';
const FIRST_VID = 'v1';

// ---- Catalyst / Stratus helpers ----------------------------------------

function stratus(req) {
  return catalyst.initialize(req, { scope: 'admin' }).stratus();
}
function bucket(req) {
  return stratus(req).bucket(BUCKET);
}

function isNotFound(err) {
  const m = ((err && (err.message || err.toString())) || '').toLowerCase();
  return /not.*found|no such|does not exist|404|key_not_found|no_such_key/.test(m);
}

async function readObject(bkt, key) {
  try {
    const stream = await bkt.getObject(key);
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function readJSON(bkt, key, fallback) {
  const raw = await readObject(bkt, key);
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

async function writeJSON(bkt, key, value) {
  await bkt.putObject(key, JSON.stringify(value), {
    contentType: 'application/json',
    overwrite: true
  });
}

function pageKey(id) { return 'pages/' + id + '.json'; }
function newId() { return crypto.randomBytes(6).toString('hex'); }

// ---- version helpers -----------------------------------------------------

// Turn any stored page (legacy or v2) into the canonical shape, in memory only.
function normalizePage(p) {
  if (!p) return p;
  if (!Array.isArray(p.versions)) {
    p.versions = [{
      vid: FIRST_VID,
      label: 'Version 1',
      html: typeof p.html === 'string' ? p.html : '',
      created: p.created || new Date().toISOString(),
      updated: p.updated || null
    }];
  }
  delete p.html; // html now lives inside versions
  if (typeof p.versioning !== 'boolean') p.versioning = false;
  if (!p.live || !p.versions.some(v => v.vid === p.live)) {
    p.live = p.versions[0] ? p.versions[0].vid : null;
  }
  return p;
}

function getVersion(p, vid) {
  return (p.versions || []).find(v => v.vid === vid) || null;
}
function liveVersion(p) {
  return getVersion(p, p.live) || p.versions[0] || null;
}
function newVid(p) {
  let vid;
  do { vid = crypto.randomBytes(4).toString('hex'); } while (getVersion(p, vid));
  return vid;
}

// Metadata (no html) for a normalized page — used for both detail list and index.
function toMeta(p) {
  return {
    id: p.id,
    title: p.title,
    disabled: !!p.disabled,
    created: p.created,
    updated: p.updated || null,
    versioning: !!p.versioning,
    live: p.live,
    versions: (p.versions || []).map(v => ({
      vid: v.vid, label: v.label, created: v.created, updated: v.updated || null
    }))
  };
}

// Fill in version fields for a legacy index entry that predates versioning.
function enrichMeta(m) {
  if (!m) return m;
  if (!Array.isArray(m.versions)) {
    m.versioning = !!m.versioning;
    m.live = FIRST_VID;
    m.versions = [{ vid: FIRST_VID, label: 'Version 1', created: m.created, updated: m.updated || null }];
  }
  return m;
}

// ---- index ---------------------------------------------------------------

async function getIndex(bkt) {
  const idx = await readJSON(bkt, INDEX_KEY, null);
  if (Array.isArray(idx)) return idx;
  return rebuildIndex(bkt);
}

async function rebuildIndex(bkt) {
  const metas = [];
  try {
    const iter = bkt.listIterableObjects({ prefix: 'pages/', maxKeys: 100 });
    for await (const obj of iter) {
      const key = obj.key || obj.Key || obj.name;
      if (!key || !key.endsWith('.json')) continue;
      const p = await readJSON(bkt, key, null);
      if (p && p.id) metas.push(toMeta(normalizePage(p)));
    }
  } catch (e) {
    // listing unavailable (e.g. bucket just created / empty) — start fresh
  }
  metas.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  await writeJSON(bkt, INDEX_KEY, metas).catch(() => {});
  return metas;
}

async function saveIndexEntry(bkt, meta) {
  const idx = await getIndex(bkt);
  const i = idx.findIndex(m => m.id === meta.id);
  if (i >= 0) idx[i] = meta; else idx.push(meta);
  await writeJSON(bkt, INDEX_KEY, idx);
}

async function removeIndexEntry(bkt, id) {
  const idx = await getIndex(bkt);
  await writeJSON(bkt, INDEX_KEY, idx.filter(m => m.id !== id));
}

// Load + normalize a stored page.
async function loadPage(bkt, id) {
  const p = await readJSON(bkt, pageKey(id), null);
  return p ? normalizePage(p) : null;
}

// ---- auth ----------------------------------------------------------------

function requireAdmin(req, res, next) {
  if (!ADMIN_KEY) return next(); // no passcode configured -> open management
  const key = req.get('x-admin-key');
  if (key && key === ADMIN_KEY) return next();
  return res.status(401).json({ error: 'Wrong or missing passcode.' });
}

// ---- health & status -----------------------------------------------------

app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.get('/api/status', async (req, res) => {
  let bucketReady = false;
  try { bucketReady = await stratus(req).headBucket(BUCKET); } catch (e) { bucketReady = false; }
  res.json({ bucket: BUCKET, bucketReady, authRequired: !!ADMIN_KEY });
});

// ---- public share link ---------------------------------------------------

function errorPage(res, code, heading, body) {
  res.status(code).type('html').send(
    '<!doctype html><meta charset=utf8><title>' + heading + '</title>' +
    '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0e0f1e;' +
    'color:#e9eaf7;font-family:system-ui,sans-serif;text-align:center;padding:24px}' +
    'h1{font-size:1.4rem;margin:0 0 .4rem}p{color:#9a9cc6;margin:0;max-width:34ch}</style>' +
    '<div><h1>' + heading + '</h1><p>' + body + '</p></div>'
  );
}

function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// A dependency-free (no JS needed) version switcher injected into served HTML.
function versionBar(p, currentVid) {
  const items = p.versions.map(v => {
    const cur = v.vid === currentVid;
    const isLive = v.vid === p.live;
    return '<a href="?v=' + escAttr(v.vid) + '" style="text-decoration:none;color:#e9eaf7;' +
      'padding:8px 12px;border-radius:8px;font-size:13px;display:flex;justify-content:space-between;' +
      'gap:14px;align-items:center;background:' + (cur ? '#2d2e5e' : 'transparent') + ';">' +
      '<span>' + escAttr(v.label) + '</span>' +
      '<span style="font-size:10px;letter-spacing:.04em;text-transform:uppercase;opacity:.7">' +
        (isLive ? 'live' : '') + (cur ? (isLive ? ' · now' : 'now') : '') + '</span>' +
    '</a>';
  }).join('');
  const curLabel = (getVersion(p, currentVid) || liveVersion(p) || {}).label || '';
  return '<div style="position:fixed;z-index:2147483647;left:50%;bottom:16px;transform:translateX(-50%);' +
    'font-family:system-ui,-apple-system,sans-serif;line-height:1.3">' +
    '<details style="background:#191a30;color:#e9eaf7;border:1px solid #33355c;border-radius:14px;' +
      'box-shadow:0 10px 34px -12px rgba(0,0,0,.7);overflow:hidden">' +
      '<summary style="list-style:none;cursor:pointer;padding:9px 16px;font-size:13px;font-weight:600;' +
        'display:flex;align-items:center;gap:8px;user-select:none">' +
        '<span style="width:7px;height:7px;border-radius:50%;background:#8f82ff;display:inline-block"></span>' +
        '<span style="opacity:.7">Version:</span><b>' + escAttr(curLabel) + '</b>' +
        '<span style="opacity:.55;font-size:11px">&#9650;&#9660; switch</span>' +
      '</summary>' +
      '<div style="padding:6px;display:flex;flex-direction:column;gap:2px;min-width:220px;max-height:50vh;overflow:auto;border-top:1px solid #33355c">' +
        items +
      '</div>' +
    '</details>' +
  '</div>';
}

function sendVersionedHtml(res, p, version, showBar) {
  let html = version.html || '';
  if (showBar) {
    const bar = versionBar(p, version.vid);
    if (/<\/body>/i.test(html)) html = html.replace(/<\/body>(?![\s\S]*<\/body>)/i, bar + '</body>');
    else html = html + bar;
  }
  res.set('Content-Security-Policy', 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads');
  res.type('html').send(html);
}

app.get('/p/:id', async (req, res) => {
  try {
    const p = await loadPage(bucket(req), req.params.id);
    if (!p) return errorPage(res, 404, 'Page not found', 'This link doesn’t point to a page — it may have been deleted.');
    if (p.disabled) return errorPage(res, 403, 'Page turned off', 'The owner has temporarily disabled this page.');

    // A ?v=<vid> direct link always resolves (so you can share one exact version).
    // The "Allow versioning" toggle only controls whether the floating switcher is shown.
    let version = liveVersion(p);
    if (req.query.v) {
      const requested = getVersion(p, String(req.query.v));
      if (requested) version = requested;
    }
    if (!version) return errorPage(res, 404, 'Nothing here yet', 'This page has no content.');

    const showBar = p.versioning && p.versions.length > 1;
    sendVersionedHtml(res, p, version, showBar);
  } catch (err) {
    return errorPage(res, 500, 'Something went wrong', 'The page could not be loaded. Please try again.');
  }
});

// ---- management API (owner) ----------------------------------------------

app.get('/api/pages', requireAdmin, async (req, res) => {
  try {
    const idx = await getIndex(bucket(req));
    res.json({ pages: idx.map(enrichMeta) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Full page incl. each version's html (for the editor).
app.get('/api/pages/:id', requireAdmin, async (req, res) => {
  try {
    const p = await loadPage(bucket(req), req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    res.json({ page: p });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// A single version's html.
app.get('/api/pages/:id/versions/:vid', requireAdmin, async (req, res) => {
  try {
    const p = await loadPage(bucket(req), req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const v = getVersion(p, req.params.vid);
    if (!v) return res.status(404).json({ error: 'Version not found' });
    res.json({ version: v });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/pages', requireAdmin, async (req, res) => {
  try {
    const html = (req.body && req.body.html) || '';
    if (!html.trim()) return res.status(400).json({ error: 'HTML is empty.' });
    const bkt = bucket(req);
    const now = new Date().toISOString();
    const page = {
      id: newId(),
      title: ((req.body.title || '') + '').trim() || 'Untitled page',
      disabled: false,
      versioning: !!req.body.versioning,
      live: FIRST_VID,
      versions: [{ vid: FIRST_VID, label: 'Version 1', html, created: now, updated: null }],
      created: now,
      updated: null
    };
    await writeJSON(bkt, pageKey(page.id), page);
    await saveIndexEntry(bkt, toMeta(page));
    res.json({ page: toMeta(page) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update page-level fields: title, disabled, versioning, live. `html` replaces the live version.
app.put('/api/pages/:id', requireAdmin, async (req, res) => {
  try {
    const bkt = bucket(req);
    const p = await loadPage(bkt, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const now = new Date().toISOString();
    const b = req.body || {};
    if (typeof b.title === 'string' && b.title.trim()) p.title = b.title.trim();
    if (typeof b.disabled === 'boolean') p.disabled = b.disabled;
    if (typeof b.versioning === 'boolean') p.versioning = b.versioning;
    if (typeof b.live === 'string' && getVersion(p, b.live)) p.live = b.live;
    if (typeof b.html === 'string') {
      const lv = liveVersion(p);
      if (lv) { lv.html = b.html; lv.updated = now; }
    }
    p.updated = now;
    await writeJSON(bkt, pageKey(p.id), p);
    await saveIndexEntry(bkt, toMeta(p));
    res.json({ page: toMeta(p) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Add a new version.
app.post('/api/pages/:id/versions', requireAdmin, async (req, res) => {
  try {
    const bkt = bucket(req);
    const p = await loadPage(bkt, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const b = req.body || {};
    const html = (b.html || '');
    if (!html.trim()) return res.status(400).json({ error: 'HTML is empty.' });
    const now = new Date().toISOString();
    const vid = newVid(p);
    const version = {
      vid,
      label: ((b.label || '') + '').trim() || ('Version ' + (p.versions.length + 1)),
      html,
      created: now,
      updated: null
    };
    p.versions.push(version);
    if (b.makeLive) p.live = vid;
    if (b.enableVersioning) p.versioning = true;
    p.updated = now;
    await writeJSON(bkt, pageKey(p.id), p);
    await saveIndexEntry(bkt, toMeta(p));
    res.json({ page: toMeta(p), vid });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Edit a version's html / label.
app.put('/api/pages/:id/versions/:vid', requireAdmin, async (req, res) => {
  try {
    const bkt = bucket(req);
    const p = await loadPage(bkt, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    const v = getVersion(p, req.params.vid);
    if (!v) return res.status(404).json({ error: 'Version not found' });
    const b = req.body || {};
    if (typeof b.html === 'string') v.html = b.html;
    if (typeof b.label === 'string' && b.label.trim()) v.label = b.label.trim();
    v.updated = new Date().toISOString();
    p.updated = v.updated;
    await writeJSON(bkt, pageKey(p.id), p);
    await saveIndexEntry(bkt, toMeta(p));
    res.json({ page: toMeta(p) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete a version (never the last one; live reassigns if needed).
app.delete('/api/pages/:id/versions/:vid', requireAdmin, async (req, res) => {
  try {
    const bkt = bucket(req);
    const p = await loadPage(bkt, req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found' });
    if (p.versions.length <= 1) return res.status(400).json({ error: 'A page must keep at least one version.' });
    if (!getVersion(p, req.params.vid)) return res.status(404).json({ error: 'Version not found' });
    p.versions = p.versions.filter(v => v.vid !== req.params.vid);
    if (p.live === req.params.vid) p.live = p.versions[0].vid;
    p.updated = new Date().toISOString();
    await writeJSON(bkt, pageKey(p.id), p);
    await saveIndexEntry(bkt, toMeta(p));
    res.json({ page: toMeta(p) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/pages/:id', requireAdmin, async (req, res) => {
  try {
    const bkt = bucket(req);
    try { await bkt.deleteObject(pageKey(req.params.id)); } catch (e) { if (!isNotFound(e)) throw e; }
    await removeIndexEntry(bkt, req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- static manager UI ----------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const server = app.listen(PORT, () => console.log('ShareHTML listening on ' + PORT));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
