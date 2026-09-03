const { propsCol } = require('./_lib/firebase');
const { FIELDS, BY_KEY, EXTRA_KEYS, missingFields, computeStatus, officeHoursText } = require('./_lib/schema');
const { json, readBody, isAdmin } = require('./_lib/util');
const { recomputeRegional } = require('./_lib/status');

// Sheet columns a reviewer may change, plus the office-hours picker payload.
const SHEET_EDITABLE = FIELDS.filter(f => !f.locked && !f.system).map(f => f.key);
const EDITABLE = SHEET_EDITABLE.concat(EXTRA_KEYS);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only.' });
  try {
    const body = await readBody(req);
    const { waveId, propertyId, verify } = body;
    const personName = String(body.personName || '').trim();
    const incoming = body.fields && typeof body.fields === 'object' ? body.fields : {};

    if (!waveId || !propertyId) return json(res, 400, { error: 'waveId and propertyId are required.' });
    if (verify && !personName) return json(res, 400, { error: 'Please enter your name before confirming.' });

    const ref = propsCol(waveId).doc(propertyId);
    const snap = await ref.get();
    if (!snap.exists) return json(res, 404, { error: 'Property not found.' });

    const prop = snap.data();

    // Confirmation is final for reviewers. Only an admin can reopen a property,
    // which is exactly what the on-screen message tells people to ask for.
    if (prop.verified && !isAdmin(req)) {
      return json(res, 409, {
        error: 'This property has already been confirmed and is locked. Reach out to Carlie Ahern on Teams to make a correction.',
        locked: true
      });
    }

    const before = Object.assign({}, prop.fields || {});
    const after = Object.assign({}, before);

    // Only accept the editable columns; property name/code/RM stay as imported.
    for (const key of EDITABLE) {
      if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
      const v = incoming[key];
      after[key] = v == null ? '' : String(v).trim();
    }

    // Bake in the workbook's HappyCo formulas so exports match the sheet exactly.
    for (const f of FIELDS) {
      if (!f.autoIf) continue;
      if (String(after[f.autoIf.field] || '').trim() === f.autoIf.equals) after[f.key] = f.autoIf.value;
    }
    // Clear the emergency number if they switched that answer to No.
    for (const f of FIELDS) {
      if (f.hiddenIf && String(after[f.hiddenIf.field] || '').trim() === f.hiddenIf.equals) after[f.key] = '';
    }
    // Keep the flat Office Hours text in step with the day/time picker.
    after.officeHours = officeHoursText(after);

    const changes = [];
    for (const key of SHEET_EDITABLE) {
      const a = before[key] == null ? '' : String(before[key]).trim();
      const b = after[key] == null ? '' : String(after[key]).trim();
      if (a !== b) changes.push({ key, label: (BY_KEY[key] || {}).label || key, from: a, to: b });
    }

    const missing = missingFields(after);
    if (verify && missing.length) {
      return json(res, 400, {
        error: 'Some required information is still blank.',
        missing,
        missingLabels: missing.map(k => (BY_KEY[k] || {}).label || k)
      });
    }

    const now = new Date().toISOString();
    const update = {
      fields: after,
      touched: true,
      updatedAt: now,
      updatedBy: personName || prop.updatedBy || null
    };

    if (verify) {
      update.verified = true;
      update.verifiedAt = now;
      update.verifiedBy = personName;
      update.fields = Object.assign({}, after, { completedBy: personName });
      update.verifiedAction = changes.length ? 'corrected' : 'confirmed';
    }

    if (changes.length || verify) {
      const history = Array.isArray(prop.history) ? prop.history.slice(-49) : [];
      history.push({
        at: now,
        by: personName || 'unknown',
        action: verify ? (changes.length ? 'corrected' : 'confirmed') : 'saved',
        changes
      });
      update.history = history;
    }

    await ref.set(update, { merge: true });

    const merged = Object.assign({}, prop, update);
    const regional = await recomputeRegional(waveId, prop.rmSlug);

    return json(res, 200, {
      ok: true,
      property: {
        id: propertyId,
        fields: merged.fields,
        verified: !!merged.verified,
        touched: true,
        status: computeStatus(merged),
        missing: missingFields(merged.fields),
        verifiedAt: merged.verifiedAt || null,
        verifiedBy: merged.verifiedBy || null,
        updatedAt: now,
        changeCount: (merged.history || []).length
      },
      regional,
      changed: changes.length
    });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
