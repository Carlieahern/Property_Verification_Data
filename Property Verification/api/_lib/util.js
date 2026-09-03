function slug(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'unknown';
}

function json(res, status, body) {
  res.status(status).setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(body));
}

function readBody(req) {
  // Vercel parses JSON bodies automatically, but fall back for safety.
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body);
  if (typeof req.body === 'string' && req.body) {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch (e) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function isAdmin(req) {
  const key = process.env.ADMIN_KEY;
  if (!key) return false;
  // Header only, deliberately: keeping the passcode out of URLs stops it landing
  // in browser history, bookmarks and server access logs.
  const got = req.headers['x-admin-key'] || '';
  return String(got) === String(key);
}

function requireAdmin(req, res) {
  if (isAdmin(req)) return true;
  json(res, 401, { error: 'Admin passcode required or incorrect.' });
  return false;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = { slug, json, readBody, isAdmin, requireAdmin, esc };
