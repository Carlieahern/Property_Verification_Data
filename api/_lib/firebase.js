const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

// ---------------------------------------------------------------------------
// ISOLATION NOTE
// This app must run against its OWN Firebase project -- never the one holding
// live company assumption data. It touches exactly two top-level collections,
// listed in ALLOWED below, and every database handle in the app is created
// through the helpers at the bottom of this file. There is deliberately no
// exported raw collection() accessor.
// ---------------------------------------------------------------------------
const ALLOWED = ['pvWaves', 'pvEmailLog'];

let db = null;

// Hosting platforms store the PEM key as a single line, so the newlines arrive as
// the two characters \ and n and have to be turned back into real line breaks.
// Some platforms also keep the surrounding quotes from the .env file.
function normalizePrivateKey(raw) {
  let key = String(raw || '').trim();

  if (key.length > 1 &&
      ((key[0] === '"' && key[key.length - 1] === '"') ||
       (key[0] === "'" && key[key.length - 1] === "'"))) {
    key = key.slice(1, -1);
  }

  key = key
    .replace(/\\r/g, '')      // literal backslash-r
    .replace(/\\n/g, '\n')    // literal backslash-n -> real newline
    .replace(/\r/g, '')       // stray carriage returns
    .trim();

  return key + '\n';
}

function getDb() {
  if (db) return db;
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const rawKey = process.env.FIREBASE_PRIVATE_KEY;

    if (!projectId || !clientEmail || !rawKey) {
      throw new Error('Firebase env vars missing. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel.');
    }

    const privateKey = normalizePrivateKey(rawKey);

    // Fail loudly and specifically rather than letting Google reject a mangled
    // key later as an opaque "16 UNAUTHENTICATED".
    if (!/^-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(privateKey) ||
        !/-----END [A-Z ]*PRIVATE KEY-----$/.test(privateKey.trim())) {
      throw new Error('FIREBASE_PRIVATE_KEY is not a valid PEM key. Paste the whole private_key value from the service account JSON, from -----BEGIN to -----END.');
    }
    if (privateKey.split('\n').length < 3) {
      throw new Error('FIREBASE_PRIVATE_KEY has no line breaks. Keep the \\n sequences from the JSON file intact when pasting it into Vercel.');
    }

    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  }
  db = getFirestore();
  return db;
}

function col(name) {
  if (!ALLOWED.includes(name)) {
    throw new Error(`Refusing to access collection "${name}" - this app may only touch: ${ALLOWED.join(', ')}`);
  }
  return getDb().collection(name);
}

const wavesCol = ()   => col('pvWaves');
const waveDoc  = (id) => wavesCol().doc(id);
const propsCol = (id) => waveDoc(id).collection('properties');
const regCol   = (id) => waveDoc(id).collection('regionals');
const emailCol = ()   => col('pvEmailLog');

module.exports = { getDb, col, wavesCol, waveDoc, propsCol, regCol, emailCol };
