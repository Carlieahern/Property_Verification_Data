const { wavesCol, waveDoc, regCol } = require('./_lib/firebase');
const { json } = require('./_lib/util');

function waveSummary(id, w) {
  return {
    id: id,
    name: w.name,
    createdAt: w.createdAt,
    archived: !!w.archived,
    propertyCount: w.propertyCount || 0,
    regionalCount: w.regionalCount || 0,
    dueDate: w.dueDate || null,
    transitionDate: w.transitionDate || null
  };
}

module.exports = async (req, res) => {
  try {
    const q = req.query || {};
    const waveId = q.wave;
    const scope = q.scope;

    // A single wave: its details plus every Regional in it.
    if (waveId && waveId !== 'all') {
      const wSnap = await waveDoc(waveId).get();
      if (!wSnap.exists) return json(res, 404, { error: 'Wave not found.' });
      const wave = Object.assign({ id: wSnap.id }, wSnap.data());

      const rSnap = await regCol(waveId).get();
      const regionals = rSnap.docs
        .map((d) => Object.assign({ rmSlug: d.id }, d.data()))
        .sort((a, b) => String(a.rmName || '').localeCompare(String(b.rmName || '')));

      return json(res, 200, { wave, regionals });
    }

    const snap = await wavesCol().orderBy('createdAt', 'desc').get();
    const all = snap.docs.map((d) => ({ id: d.id, data: d.data() }));

    // Every Regional across all open waves, merged under one name. This is what
    // lets someone open the plain link and simply find themselves, without having
    // to know which wave they belong to.
    if (scope === 'open') {
      const open = all.filter((w) => !w.data.archived);
      const byRm = new Map();

      for (const w of open) {
        const rSnap = await regCol(w.id).get();
        for (const d of rSnap.docs) {
          const r = d.data();
          if (!byRm.has(d.id)) {
            byRm.set(d.id, { rmSlug: d.id, rmName: r.rmName || d.id, total: 0, verified: 0, waves: [] });
          }
          const agg = byRm.get(d.id);
          agg.total += r.total || 0;
          agg.verified += r.verified || 0;
          agg.waves.push({ id: w.id, name: w.data.name, total: r.total || 0, verified: r.verified || 0 });
        }
      }

      const regionals = Array.from(byRm.values())
        .map((r) => Object.assign(r, { complete: r.total > 0 && r.verified === r.total }))
        .sort((a, b) => String(a.rmName).localeCompare(String(b.rmName)));

      return json(res, 200, { waves: open.map((w) => waveSummary(w.id, w.data)), regionals });
    }

    return json(res, 200, { waves: all.map((w) => waveSummary(w.id, w.data)) });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
