const { propsCol, regCol } = require('./firebase');
const { computeStatus } = require('./schema');

function baseUrl() {
  return (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
}

// Not scoped to a wave: one link opens a person's full view, all open waves
// newest first, so nobody has to work out which wave they belong to.
function portfolioUrl(waveId, rmSlug) {
  return `${baseUrl()}/?rm=${encodeURIComponent(rmSlug)}`;
}

// Recalculates one Regional's progress from their properties. `completedAt` is
// stamped the first time they reach 100% and cleared if a property is reopened.
async function recomputeRegional(waveId, rmSlug) {
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
  if (!complete) patch.completedAt = null;

  await regRef.set(patch, { merge: true });
  return { ...reg, ...patch };
}

// Rebuilds every Regional in a wave (used after import and by the admin dashboard).
async function recomputeWave(waveId) {
  const regs = await regCol(waveId).get();
  const out = [];
  for (const d of regs.docs) {
    out.push(await recomputeRegional(waveId, d.id));
  }
  return out;
}

module.exports = { recomputeRegional, recomputeWave, portfolioUrl, baseUrl };
