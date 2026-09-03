const { waveDoc, propsCol, regCol } = require('./firebase');
const { computeStatus } = require('./schema');
const { sendEmail, completionEmail } = require('./email');

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

// Deliberately not scoped to a wave: every emailed link opens the person's full
// view, all open waves newest first, so nobody has to work out which wave they are in.
function portfolioUrl(waveId, rmSlug) {
  return `${baseUrl()}/?rm=${encodeURIComponent(rmSlug)}`;
}

// Recalculates one Regional's progress from their properties and, the first time
// they hit 100%, emails the notify address. `notifiedAt` makes that idempotent so
// a later edit-and-resave cannot trigger a duplicate alert.
async function recomputeRegional(waveId, rmSlug, opts = {}) {
  const snap = await propsCol(waveId).where('rmSlug', '==', rmSlug).get();
  const props = snap.docs.map(d => ({ id: d.id, ...d.data() }));

  const total = props.length;
  const verified = props.filter(p => computeStatus(p) === 'verified').length;
  const outstanding = props
    .filter(p => computeStatus(p) !== 'verified')
    .map(p => (p.fields && p.fields.propertyName) || p.id);

  const regRef = regCol(waveId).doc(rmSlug);
  const regSnap = await regRef.get();
  const reg = regSnap.exists ? regSnap.data() : {};
  const rmName = reg.rmName || (props[0] && props[0].fields && props[0].fields.rmName) || rmSlug;

  const complete = total > 0 && verified === total;
  const patch = {
    rmSlug,
    rmName,
    total,
    verified,
    outstanding,
    complete,
    updatedAt: new Date().toISOString()
  };
  if (complete && !reg.completedAt) patch.completedAt = new Date().toISOString();
  if (!complete) { patch.completedAt = null; }

  await regRef.set(patch, { merge: true });

  // Fire the "portfolio finished" alert once.
  if (complete && !reg.notifiedAt && opts.notify !== false) {
    const waveSnap = await waveDoc(waveId).get();
    const waveName = (waveSnap.exists && waveSnap.data().name) || waveId;
    const notify = process.env.NOTIFY_EMAIL;
    if (notify) {
      await sendEmail({
        to: notify,
        subject: `${waveName} complete: ${rmName} (${total} ${total === 1 ? 'property' : 'properties'})`,
        html: completionEmail({
          rmName, waveName, total,
          url: portfolioUrl(waveId, rmSlug),
          completedAt: patch.completedAt || new Date().toISOString()
        }),
        kind: 'portfolio_complete',
        meta: { waveId, rmSlug, total }
      });
    }
    await regRef.set({ notifiedAt: new Date().toISOString() }, { merge: true });
  }

  return { ...reg, ...patch };
}

// Rebuilds every Regional in a wave (used after import and by the admin dashboard).
async function recomputeWave(waveId, opts = {}) {
  const regs = await regCol(waveId).get();
  const out = [];
  for (const d of regs.docs) {
    out.push(await recomputeRegional(waveId, d.id, opts));
  }
  return out;
}

module.exports = { recomputeRegional, recomputeWave, portfolioUrl, baseUrl };
