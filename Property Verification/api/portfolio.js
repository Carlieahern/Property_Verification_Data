const { wavesCol, waveDoc, propsCol, regCol } = require('./_lib/firebase');
const { computeStatus, missingFields } = require('./_lib/schema');
const { json } = require('./_lib/util');

function viewOf(p, wave) {
  const fields = Object.assign({}, p.fields || {});
  // A property with no transition date of its own inherits the wave's.
  if (!fields.transitionDate && wave && wave.transitionDate) fields.transitionDate = wave.transitionDate;
  return {
    id: p.id,
    waveId: wave.id,
    waveName: wave.name,
    dueDate: wave.dueDate || null,
    fields: fields,
    verified: !!p.verified,
    touched: !!p.touched,
    status: computeStatus({ fields: fields, verified: p.verified, touched: p.touched }),
    missing: missingFields(fields),
    verifiedAt: p.verifiedAt || null,
    verifiedBy: p.verifiedBy || null,
    updatedAt: p.updatedAt || null
  };
}

const byName = (a, b) =>
  String(a.fields.propertyName || '').localeCompare(String(b.fields.propertyName || ''));

// Newest wave first: Wave 6 sits above Wave 5. Ordered by the number in the name
// where there is one, falling back to when the wave was created.
function waveRank(w) {
  const m = String(w.name || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : -1;
}
function newestFirst(a, b) {
  const ra = waveRank(a), rb = waveRank(b);
  if (ra !== rb) return rb - ra;
  return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
}

async function loadWaveProps(waveId, waveData, rmSlug) {
  const snap = await propsCol(waveId).where('rmSlug', '==', rmSlug).get();
  const wave = Object.assign({ id: waveId }, waveData);
  return snap.docs.map((d) => viewOf(Object.assign({ id: d.id }, d.data()), wave));
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const rmSlug = q.rm;
    const waveId = q.wave;
    if (!rmSlug) return json(res, 400, { error: 'rm is required.' });

    // Scoped to one wave -- this is what a per-wave link opens.
    if (waveId && waveId !== 'all') {
      const wSnap = await waveDoc(waveId).get();
      if (!wSnap.exists) return json(res, 404, { error: 'Wave not found.' });
      const waveData = wSnap.data();

      const rSnap = await regCol(waveId).doc(rmSlug).get();
      const properties = (await loadWaveProps(waveId, waveData, rmSlug)).sort(byName);

      return json(res, 200, {
        scope: 'wave',
        waves: [Object.assign({ id: wSnap.id }, waveData, {
          myTotal: properties.length,
          myVerified: properties.filter((p) => p.status === 'verified').length
        })],
        regional: rSnap.exists ? Object.assign({ rmSlug }, rSnap.data()) : { rmSlug, rmName: rmSlug },
        properties
      });
    }

    // No wave given: everything still open for this person, across every wave.
    const snap = await wavesCol().orderBy('createdAt', 'desc').get();
    const open = snap.docs.filter((d) => !d.data().archived);

    let properties = [];
    let waves = [];
    let rmName = rmSlug;
    let total = 0, verified = 0;

    for (const d of open) {
      const waveData = d.data();
      const rSnap = await regCol(d.id).doc(rmSlug).get();
      if (!rSnap.exists) continue;
      const reg = rSnap.data();
      rmName = reg.rmName || rmName;
      total += reg.total || 0;
      verified += reg.verified || 0;
      const props = await loadWaveProps(d.id, waveData, rmSlug);
      waves.push(Object.assign({ id: d.id }, waveData, {
        myTotal: props.length,
        myVerified: props.filter((p) => p.status === 'verified').length
      }));
      properties = properties.concat(props);
    }

    waves.sort(newestFirst);
    const order = {};
    waves.forEach((w, i) => { order[w.id] = i; });
    properties.sort((a, b) => (order[a.waveId] - order[b.waveId]) || byName(a, b));

    return json(res, 200, {
      scope: 'open',
      waves,
      regional: { rmSlug, rmName, total, verified, complete: total > 0 && verified === total },
      properties
    });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
