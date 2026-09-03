const { waveDoc, propsCol, regCol, getDb } = require('./_lib/firebase');
const { FIELDS, DAY_KEYS, DAY_LABEL, DAY_FULL, isBlank,
        parseHoursText, parseHoursColumns, formatHours } = require('./_lib/schema');
const { json, readBody, requireAdmin, slug } = require('./_lib/util');
const { recomputeWave } = require('./_lib/status');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

// Header text -> field key. Includes the workbook's exact headers plus tolerant
// aliases, so a re-typed or slightly reworded header in a future wave still lands.
const HEADER_MAP = {};
for (const f of FIELDS) {
  HEADER_MAP[norm(f.sheetHeader)] = f.key;
  HEADER_MAP[norm(f.label)] = f.key;
  HEADER_MAP[norm(f.key)] = f.key;
}
Object.assign(HEADER_MAP, {
  [norm('RM Name')]: 'rmName',
  [norm('Regional')]: 'rmName',
  [norm('Regional Manager')]: 'rmName',
  [norm('RVP')]: 'rmName',
  [norm('Property')]: 'propertyName',
  [norm('Code')]: 'propertyCode',
  [norm('Property ID')]: 'propertyCode',
  [norm('Do residents call maintenance directly for emergencies?')]: 'maintDirect',
  [norm('Emergency Number')]: 'maintNumber',
  [norm('Transition Date')]: 'transitionDate',
  [norm('Transition')]: 'transitionDate',
  [norm('CRMiQ Date')]: 'transitionDate',
  [norm('CRMiQ Transition Date')]: 'transitionDate',
  [norm('Go Live Date')]: 'transitionDate'
});

// Optional per-day office-hours columns, taking precedence over a single
// free-text "Office Hours" cell when present.
const DAY_HEADER = {};
for (const d of DAY_KEYS) {
  for (const n of [DAY_FULL[d], DAY_LABEL[d]]) {
    DAY_HEADER[norm(n)] = { day: d, part: 'range' };
    DAY_HEADER[norm(n + ' Hours')] = { day: d, part: 'range' };
    DAY_HEADER[norm(n + ' Office Hours')] = { day: d, part: 'range' };
    DAY_HEADER[norm(n + ' Open')] = { day: d, part: 'open' };
    DAY_HEADER[norm(n + ' Opens')] = { day: d, part: 'open' };
    DAY_HEADER[norm(n + ' Open Time')] = { day: d, part: 'open' };
    DAY_HEADER[norm(n + ' Close')] = { day: d, part: 'close' };
    DAY_HEADER[norm(n + ' Closes')] = { day: d, part: 'close' };
    DAY_HEADER[norm(n + ' Close Time')] = { day: d, part: 'close' };
  }
}

// Reference columns describe the property; the rest are answers to be verified.
const REFERENCE_KEYS = FIELDS.filter(f => f.locked).map(f => f.key);
const ANSWER_KEYS = FIELDS.filter(f => !f.locked).map(f => f.key).concat(['officeHoursStruct']);

async function commitChunked(ops) {
  const db = getDb();
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 400)) batch.set(op.ref, op.data, { merge: !!op.merge });
    await batch.commit();
  }
}

async function deleteAll(collectionRef) {
  const db = getDb();
  const snap = await collectionRef.get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

// Turn one spreadsheet row into { fields } or null if the row is unusable.
function readRow(raw, unmatched) {
  const fields = {};
  const byDay = {};

  for (const [header, value] of Object.entries(raw)) {
    const h = norm(header);
    const v = isBlank(value) ? '' : String(value).trim();   // "-" counts as blank

    const dayCol = DAY_HEADER[h];
    if (dayCol) {
      if (v) {
        if (!byDay[dayCol.day]) byDay[dayCol.day] = {};
        byDay[dayCol.day][dayCol.part] = v;
      }
      continue;
    }

    const key = HEADER_MAP[h];
    if (!key) { if (String(header).trim()) unmatched.add(String(header).trim()); continue; }
    fields[key] = v;
  }

  if (!fields.propertyName && !fields.propertyCode) return null;
  if (!fields.rmName) fields.rmName = 'Unassigned';
  if (fields.completedBy === undefined) fields.completedBy = '';

  const hours = parseHoursColumns(byDay) || parseHoursText(fields.officeHours);
  if (hours) {
    fields.officeHoursStruct = JSON.stringify(hours);
    fields.officeHours = formatHours(hours);
  }
  return { fields, hoursParsed: !!hours };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
  if (!requireAdmin(req, res)) return;

  try {
    const body = await readBody(req);
    const rows = Array.isArray(body.rows) ? body.rows : [];
    const waveName = String(body.waveName || '').trim();
    if (!waveName) return json(res, 400, { error: 'Give the wave a name, e.g. "Wave 6".' });
    if (!rows.length) return json(res, 400, { error: 'No rows found in that file.' });

    // create  = wave must not exist yet
    // update  = merge into an existing wave, never touching confirmed properties
    // replace = wipe the wave and rebuild it
    let mode = body.mode || (body.overwrite ? 'replace' : 'create');
    if (['create', 'update', 'replace'].indexOf(mode) === -1) mode = 'create';

    const waveId = slug(waveName);
    const existing = await waveDoc(waveId).get();

    if (existing.exists && mode === 'create') {
      return json(res, 409, {
        error: `A wave called "${waveName}" already exists. Choose "Add or update" to merge into it, or "Replace" to wipe and rebuild it.`,
        waveId
      });
    }
    if (!existing.exists && mode === 'update') mode = 'create';
    if (existing.exists && mode === 'replace') {
      await deleteAll(propsCol(waveId));
      await deleteAll(regCol(waveId));
    }

    // For a merge we need to know what is already there, and what is locked.
    const current = {};
    if (existing.exists && mode === 'update') {
      const snap = await propsCol(waveId).get();
      snap.docs.forEach(d => { current[d.id] = d.data(); });
    }

    const unmatched = new Set();
    const ops = [];
    const regionals = new Map();
    const stats = {
      added: 0, updated: 0, unchanged: 0,
      skippedConfirmed: 0, skippedEmptyRows: 0,
      hoursParsed: 0, hoursUnparsed: 0
    };
    const skippedNames = [];

    rows.forEach((raw, idx) => {
      const parsed = readRow(raw, unmatched);
      if (!parsed) { stats.skippedEmptyRows++; return; }
      const incoming = parsed.fields;

      if (parsed.hoursParsed) stats.hoursParsed++;
      else if (incoming.officeHours) stats.hoursUnparsed++;

      const rmSlug = slug(incoming.rmName);
      const propId = slug(`${incoming.propertyCode || ''}-${incoming.propertyName || ''}`) || `row-${idx}`;
      const prev = current[propId];

      if (!regionals.has(rmSlug)) regionals.set(rmSlug, { rmSlug, rmName: incoming.rmName });

      // Confirmed work is never touched by an import.
      if (prev && prev.verified) {
        stats.skippedConfirmed++;
        if (skippedNames.length < 25) skippedNames.push(incoming.propertyName || propId);
        // keep the regional registered so counts still recompute
        const pr = slug((prev.fields && prev.fields.rmName) || incoming.rmName);
        if (!regionals.has(pr)) regionals.set(pr, { rmSlug: pr, rmName: (prev.fields && prev.fields.rmName) || incoming.rmName });
        return;
      }

      if (!prev) {
        stats.added++;
        ops.push({
          ref: propsCol(waveId).doc(propId),
          data: {
            waveId, rmSlug, fields: incoming,
            verified: false, touched: false,
            importedAt: new Date().toISOString(),
            sourceRow: idx + 2, history: []
          }
        });
        return;
      }

      // Existing but unconfirmed: refresh the reference columns, and fill in
      // answers only where the app currently has nothing. Anything a person
      // already typed stays exactly as they left it.
      const prevFields = prev.fields || {};
      const merged = Object.assign({}, prevFields);
      let changed = false;

      for (const key of REFERENCE_KEYS) {
        const v = incoming[key];
        if (v !== undefined && String(v) !== String(prevFields[key] || '')) { merged[key] = v; changed = true; }
      }
      for (const key of ANSWER_KEYS) {
        const v = incoming[key];
        if (v === undefined || isBlank(v)) continue;
        if (!isBlank(prevFields[key])) continue;   // someone already answered it
        merged[key] = v;
        changed = true;
      }

      if (!changed) { stats.unchanged++; return; }
      stats.updated++;
      ops.push({
        ref: propsCol(waveId).doc(propId),
        merge: true,
        data: { waveId, rmSlug, fields: merged, updatedAt: new Date().toISOString() }
      });
    });

    if (!ops.length && !stats.skippedConfirmed && !stats.unchanged) {
      return json(res, 400, { error: 'No usable rows -- every row was missing both a Property Name and a Property Code.' });
    }

    for (const [rmSlug, r] of regionals) {
      ops.push({ ref: regCol(waveId).doc(rmSlug), merge: true, data: { rmSlug: r.rmSlug, rmName: r.rmName } });
    }

    await commitChunked(ops);

    const totalSnap = await propsCol(waveId).get();

    await waveDoc(waveId).set({
      name: waveName,
      createdAt: existing.exists ? (existing.data().createdAt || new Date().toISOString()) : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      propertyCount: totalSnap.size,
      regionalCount: (await regCol(waveId).get()).size,
      dueDate: body.dueDate !== undefined && body.dueDate !== null
        ? body.dueDate
        : (existing.exists ? (existing.data().dueDate || null) : null),
      transitionDate: body.transitionDate !== undefined && body.transitionDate !== null
        ? body.transitionDate
        : (existing.exists ? (existing.data().transitionDate || null) : null),
      archived: existing.exists ? !!existing.data().archived : false
    }, { merge: true });

    // Recalculate every Regional's totals from the properties themselves, so
    // merges and moved properties cannot leave stale counts behind.
    await recomputeWave(waveId);

    return json(res, 200, {
      ok: true, waveId, waveName, mode,
      imported: stats.added,
      added: stats.added,
      updated: stats.updated,
      unchanged: stats.unchanged,
      skippedConfirmed: stats.skippedConfirmed,
      skippedConfirmedNames: skippedNames,
      skipped: stats.skippedEmptyRows,
      regionals: regionals.size,
      totalInWave: totalSnap.size,
      hoursParsed: stats.hoursParsed,
      hoursUnparsed: stats.hoursUnparsed,
      unmatchedHeaders: Array.from(unmatched)
    });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
