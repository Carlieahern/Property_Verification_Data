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

function getDb() {
  if (db) return db;
  if (!getApps().length) {
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\n/g, '\n');
    if (!projectId || !clientEmail || !privateKey) {
      throw new Error('Firebase env vars missing. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in Vercel.');
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
