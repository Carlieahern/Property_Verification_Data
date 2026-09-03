const { wavesCol, waveDoc, propsCol, regCol, getDb } = require('./_lib/firebase');
const { FIELDS, DAY_KEYS, DAY_LABEL, DAY_FULL, isBlank,
        parseHoursText, parseHoursColumns, formatHours } = require('./_lib/schema');
const { json, readBody, requireAdmin, slug } = require('./_lib/util');

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

// Optional per-day office-hours columns. Any of these shapes work, and they take
// precedence over the single free-text "Office Hours" column when present:
//   "Monday Hours" / "Mon Hours" / "Monday"      -> "9:00 AM-6:00 PM" or "Closed"
//   "Monday Open" + "Monday Close"               -> "9:00 AM" and "6:00 PM"
const DAY_HEADER = {};
for (const d of DAY_KEYS) {
  const names = [DAY_FULL[d], DAY_LABEL[d]];
  for (const n of names) {
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

async function commitChunked(ops) {
  const db = getDb();
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    for (const op of ops.slice(i, i + 400)) batch.set(op.ref, op.data, { merge: !!op.merge });
    await batch.commit();
  }
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

    const waveId = slug(waveName);
    const existing = await waveDoc(waveId).get();
    if (existing.exists && !body.overwrite) {
      return json(res, 409, { error: `A wave called "${waveName}" already exists. Tick "replace" to overwrite it.`, waveId });
    }

    // If replacing, clear the old subcollections first.
    if (existing.exists && body.overwrite) {
      for (const c of [propsCol(waveId), regCol(waveId)]) {
        const snap = await c.get();
        const db = getDb();
        for (let i = 0; i < snap.docs.length; i += 400) {
          const batch = db.batch();
          snap.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
          await batch.commit();
        }
      }
    }

    const unmatched = new Set();
    const ops = [];
    const regionals = new Map();
    let skipped = 0;
    let hoursParsed = 0, hoursUnparsed = 0;

    rows.forEach((raw, idx) => {
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

      if (!fields.propertyName && !fields.propertyCode) { skipped++; return; }
      if (!fields.rmName) fields.rmName = 'Unassigned';
      fields.completedBy = fields.completedBy || '';

      // Per-day columns win; otherwise try to read the free-text Office Hours cell.
      // Anything we manage to read is pre-loaded into the picker for verification.
      const hours = parseHoursColumns(byDay) || parseHoursText(fields.officeHours);
      if (hours) {
        fields.officeHoursStruct = JSON.stringify(hours);
        fields.officeHours = formatHours(hours);
        hoursParsed++;
      } else if (fields.officeHours) {
        hoursUnparsed++;   // kept as free text, still verifiable as-is
      }

      const rmSlug = slug(fields.rmName);
      const propId = slug(`${fields.propertyCode || ''}-${fields.propertyName || ''}`) || `row-${idx}`;

      ops.push({
        ref: propsCol(waveId).doc(propId),
        data: {
          waveId, rmSlug, fields,
          verified: false, touched: false,
          importedAt: new Date().toISOString(),
          sourceRow: idx + 2, history: []
        }
      });

      if (!regionals.has(rmSlug)) {
        regionals.set(rmSlug, { rmSlug, rmName: fields.rmName, total: 0, verified: 0, complete: false, outstanding: [] });
      }
      const r = regionals.get(rmSlug);
      r.total += 1;
      r.outstanding.push(fields.propertyName || propId);
    });

    if (!ops.length) return json(res, 400, { error: 'No usable rows -- every row was missing both a Property Name and a Property Code.' });

    for (const [rmSlug, r] of regionals) {
      ops.push({ ref: regCol(waveId).doc(rmSlug), data: Object.assign({ updatedAt: new Date().toISOString() }, r), merge: true });
    }

    await commitChunked(ops);

    await waveDoc(waveId).set({
      name: waveName,
      createdAt: existing.exists ? (existing.data().createdAt || new Date().toISOString()) : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      propertyCount: ops.length - regionals.size,
      regionalCount: regionals.size,
      dueDate: body.dueDate || null,
      transitionDate: body.transitionDate || null,
      archived: false
    }, { merge: true });

    return json(res, 200, {
      ok: true, waveId, waveName,
      imported: ops.length - regionals.size,
      regionals: regionals.size,
      skipped,
      hoursParsed,
      hoursUnparsed,
      unmatchedHeaders: Array.from(unmatched)
    });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
};
