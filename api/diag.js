// Temporary deployment diagnostic.
// Reports the SHAPE of the credentials and the result of one Firestore read.
// It never returns the key, the project id, or the client email -- only lengths,
// booleans and the error Google gives back. Safe to leave public, but it exists
// to unblock first deploy and should be deleted once the app is working.

const { json } = require('./_lib/util');

// Bumped whenever this file changes, so it is obvious which build is live.
const BUILD_MARKER = 'key-normalize-v2';

function normalizePrivateKey(raw) {
  let key = String(raw || '').trim();
  if (key.length > 1 &&
      ((key[0] === '"' && key[key.length - 1] === '"') ||
       (key[0] === "'" && key[key.length - 1] === "'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\r/g, '').replace(/\\n/g, '\n').replace(/\r/g, '').trim();
  return key + '\n';
}

module.exports = async (req, res) => {
  const raw = process.env.FIREBASE_PRIVATE_KEY || '';
  const projectId = process.env.FIREBASE_PROJECT_ID || '';
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL || '';
  const normalized = normalizePrivateKey(raw);

  // The service account email embeds its project: xxx@<project>.iam.gserviceaccount.com
  const emailProject = (clientEmail.split('@')[1] || '').split('.')[0];

  const report = {
    buildMarker: BUILD_MARKER,
    nodeVersion: process.version,
    env: {
      FIREBASE_PROJECT_ID: !!projectId,
      FIREBASE_CLIENT_EMAIL: !!clientEmail,
      FIREBASE_PRIVATE_KEY: !!raw,
      ADMIN_KEY: !!process.env.ADMIN_KEY,
      PUBLIC_BASE_URL: !!process.env.PUBLIC_BASE_URL
    },
    key: {
      rawLength: raw.length,
      rawHasLiteralBackslashN: raw.indexOf('\\n') >= 0,
      rawHasRealNewlines: raw.indexOf('\n') >= 0,
      rawWrappedInQuotes: raw.length > 1 && (raw[0] === '"' || raw[0] === "'"),
      normalizedLength: normalized.length,
      normalizedLineCount: normalized.split('\n').length,
      startsWithBegin: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized),
      endsWithEnd: /-----END [A-Z ]*PRIVATE KEY-----$/.test(normalized.trim()),
      looksUsable: /^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(normalized) &&
                   normalized.split('\n').length > 3
    },
    identity: {
      projectIdLength: projectId.length,
      clientEmailLooksRight: /@[^@]+\.iam\.gserviceaccount\.com$/.test(clientEmail),
      // The single most common silent mismatch: key from one project, id from another.
      emailProjectMatchesProjectId: !!projectId && emailProject === projectId
    },
    firestore: null
  };

  try {
    const { getDb } = require('./_lib/firebase');
    await getDb().collection('pvWaves').limit(1).get();
    report.firestore = { ok: true, message: 'Read succeeded. Credentials and Firestore are working.' };
  } catch (e) {
    const msg = String((e && e.message) || e);
    let hint = 'Unrecognised error.';
    if (/UNAUTHENTICATED|invalid authentication/i.test(msg)) {
      hint = 'PEM parsed but Google rejected it. Usually the key was deleted from the service account, or the key and project id belong to different projects.';
    } else if (/NOT_FOUND|does not exist/i.test(msg)) {
      hint = 'Credentials accepted, but no Firestore database exists in this project. Create one in Firebase: Build > Firestore Database > Create database.';
    } else if (/PERMISSION_DENIED/i.test(msg)) {
      hint = 'Credentials accepted, but this service account lacks Firestore permission.';
    } else if (/DECODER|PEM|private key/i.test(msg)) {
      hint = 'The key value itself is malformed in the environment variable.';
    }
    report.firestore = { ok: false, error: msg.slice(0, 400), hint };
  }

  res.setHeader('Cache-Control', 'no-store');
  return json(res, 200, report);
};
