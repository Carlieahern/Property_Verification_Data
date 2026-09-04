const { waveDoc, propsCol, regCol, getDb } = require('./_lib/firebase');
const { json, readBody, requireAdmin, slug } = require('./_lib/util');
const { recomputeWave, recomputeRegional, baseUrl } = require('./_lib/status');
const { FIELDS, EXTRA_KEYS, isBlank, parseHoursText, formatHours,
        missingFields, computeStatus } = require('./_lib/schema');

const WRITABLE = FIELDS.filter(f => !f.system).map(f => f.key).concat(EXTRA_KEYS);

async function deleteAll(collectionRef) {
  const db = getDb();
  const snap = await collectionRef.get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = db.batch();
    snap.docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  return snap.docs.length;
}

module.exports = async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    const action = body.action || (req.query && req.query.action) || 'dashboard';
    const waveId = body.waveId || (req.query && req.query.wave) || null;

    if (action === 'dashboard') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const wSnap = await waveDoc(waveId).get();
      if (!wSnap.exists) return json(res, 404, { error: 'Wave not found.' });

      const rSnap = await regCol(waveId).get();
      const regionals = rSnap.docs
        .map((d) => Object.assign({ rmSlug: d.id }, d.data()))
        .sort((a, b) => String(a.rmName || '').localeCompare(String(b.rmName || '')));

      return json(res, 200, {
        wave: Object.assign({ id: wSnap.id }, wSnap.data()),
        regionals,
        baseUrl: baseUrl()
      });
    }

    if (action === 'settings') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const patch = { updatedAt: new Date().toISOString() };
      if (body.dueDate !== undefined) patch.dueDate = body.dueDate || null;
      if (body.transitionDate !== undefined) patch.transitionDate = body.transitionDate || null;
      if (body.archived !== undefined) patch.archived = !!body.archived;
      if (body.name) patch.name = String(body.name).trim();
      await waveDoc(waveId).set(patch, { merge: true });
      return json(res, 200, { ok: true, patch: patch });
    }

    // Confirmed properties are locked to reviewers. These two actions are how a
    // "please reach out to Carlie" request actually gets actioned.
    if (action === 'properties') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const snap = await propsCol(waveId).get();
      const properties = snap.docs
        .map((d) => {
          const p = d.data();
          return {
            id: d.id,
            propertyName: (p.fields || {}).propertyName || d.id,
            propertyCode: (p.fields || {}).propertyCode || '',
            rmName: (p.fields || {}).rmName || '',
            rmSlug: p.rmSlug,
            verified: !!p.verified,
            verifiedBy: p.verifiedBy || '',
            verifiedAt: p.verifiedAt || null
          };
        })
        .sort((a, b) => (a.rmName + a.propertyName).localeCompare(b.rmName + b.propertyName));
      return json(res, 200, { properties });
    }

    // Full record for one property, so the admin edit form can be populated.
    if (action === 'property') {
      const propertyId = body.propertyId || (req.query && req.query.propertyId);
      if (!waveId || !propertyId) return json(res, 400, { error: 'wave and propertyId are required.' });
      const snap = await propsCol(waveId).doc(propertyId).get();
      if (!snap.exists) return json(res, 404, { error: 'Property not found.' });
      const p = snap.data();
      return json(res, 200, {
        id: propertyId,
        fields: p.fields || {},
        verified: !!p.verified,
        verifiedBy: p.verifiedBy || '',
        verifiedAt: p.verifiedAt || null,
        missing: missingFields(p.fields || {}),
        history: (p.history || []).slice(-10)
      });
    }

    // Admin edit of an existing property. Confirmed properties are refused: a
    // signature means someone stood behind those values, so it has to be
    // reopened first rather than quietly rewritten underneath them.
    if (action === 'updateProperty') {
      const propertyId = body.propertyId;
      if (!waveId || !propertyId) return json(res, 400, { error: 'wave and propertyId are required.' });
      const ref = propsCol(waveId).doc(propertyId);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { error: 'Property not found.' });

      // A confirmed property can be edited directly. The signature is kept: the
      // admin is acting on what the property itself reported, so the person who
      // confirmed it still stands behind the record. The override is recorded.
      const prop = snap.data();
      const wasConfirmed = !!prop.verified;

      const before = Object.assign({}, prop.fields || {});
      const after = Object.assign({}, before);
      const incoming = (body.fields && typeof body.fields === 'object') ? body.fields : {};

      for (const key of WRITABLE) {
        if (!Object.prototype.hasOwnProperty.call(incoming, key)) continue;
        const v = incoming[key];
        after[key] = isBlank(v) ? '' : String(v).trim();
      }

      if (after.officeHours && after.officeHours !== before.officeHours) {
        const parsed = parseHoursText(after.officeHours);
        if (parsed) {
          after.officeHoursStruct = JSON.stringify(parsed);
          after.officeHours = formatHours(parsed);
        }
      }

      const changes = [];
      for (const key of WRITABLE) {
        const a = before[key] == null ? '' : String(before[key]).trim();
        const b = after[key] == null ? '' : String(after[key]).trim();
        if (a !== b) {
          changes.push({ key, label: (FIELDS.find(f => f.key === key) || {}).label || key, from: a, to: b });
        }
      }
      if (!changes.length) return json(res, 200, { ok: true, changed: 0, message: 'Nothing was different.' });

      const rmSlug = slug(after.rmName || before.rmName || prop.rmSlug);
      const history = Array.isArray(prop.history) ? prop.history.slice(-49) : [];
      history.push({
        at: new Date().toISOString(),
        by: 'admin',
        action: wasConfirmed ? 'admin_override' : 'admin_edit',
        note: body.note ? String(body.note).slice(0, 300) : '',
        changes
      });

      // Clearing a required field on a confirmed property leaves it incomplete,
      // which puts it back in front of the Regional. Say so rather than letting
      // a portfolio quietly stop being finished.
      const stillNeeded = missingFields(after);
      const droppedOutOfComplete = wasConfirmed && stillNeeded.length > 0;

      await ref.set({
        fields: after, rmSlug, touched: true,
        updatedAt: new Date().toISOString(), history
      }, { merge: true });

      // A changed Regional moves the property between portfolios.
      if (rmSlug !== prop.rmSlug) {
        await regCol(waveId).doc(rmSlug).set({ rmSlug, rmName: after.rmName }, { merge: true });
        await recomputeRegional(waveId, prop.rmSlug);
      }
      const regional = await recomputeRegional(waveId, rmSlug);

      return json(res, 200, {
        ok: true,
        changed: changes.length,
        changes,
        wasConfirmed,
        confirmationKept: wasConfirmed,
        confirmedBy: wasConfirmed ? (prop.verifiedBy || '') : '',
        droppedOutOfComplete,
        movedRegional: rmSlug !== prop.rmSlug ? after.rmName : null,
        stillNeededLabels: stillNeeded.map(k => (FIELDS.find(f => f.key === k) || {}).label || k),
        regional
      });
    }

    if (action === 'unlockProperty') {
      if (!waveId || !body.propertyId) return json(res, 400, { error: 'wave and propertyId are required.' });
      const ref = propsCol(waveId).doc(body.propertyId);
      const snap = await ref.get();
      if (!snap.exists) return json(res, 404, { error: 'Property not found.' });
      const prop = snap.data();
      if (!prop.verified) return json(res, 400, { error: 'That property is not locked.' });

      const history = Array.isArray(prop.history) ? prop.history.slice(-49) : [];
      history.push({
        at: new Date().toISOString(),
        by: 'admin',
        action: 'reopened',
        changes: [],
        note: body.note ? String(body.note).slice(0, 300) : ''
      });

      await ref.set({
        verified: false, verifiedAt: null, verifiedBy: null, verifiedAction: null,
        reopenedAt: new Date().toISOString(), history
      }, { merge: true });

      const regional = await recomputeRegional(waveId, prop.rmSlug);
      return json(res, 200, {
        ok: true,
        reopened: (prop.fields || {}).propertyName || body.propertyId,
        regional
      });
    }

    // Add one property by hand, for the odd site that turns up after the import.
    // Deliberately mirrors what the importer builds, so a hand-added property and
    // an imported one are indistinguishable afterwards.
    if (action === 'addProperty') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const wSnap = await waveDoc(waveId).get();
      if (!wSnap.exists) return json(res, 404, { error: 'Wave not found.' });

      const incoming = (body.fields && typeof body.fields === 'object') ? body.fields : {};
      const fields = {};
      for (const key of WRITABLE) {
        const v = incoming[key];
        fields[key] = isBlank(v) ? '' : String(v).trim();   // "-" counts as blank
      }
      fields.completedBy = '';

      if (!fields.propertyName) return json(res, 400, { error: 'Property Name is required.' });
      if (!fields.rmName) return json(res, 400, { error: 'Regional Manager is required.' });

      // Accept the same office-hours shorthand the importer takes.
      if (fields.officeHours && !fields.officeHoursStruct) {
        const parsed = parseHoursText(fields.officeHours);
        if (parsed) {
          fields.officeHoursStruct = JSON.stringify(parsed);
          fields.officeHours = formatHours(parsed);
        }
      }

      const rmSlug = slug(fields.rmName);
      const propId = slug(`${fields.propertyCode || ''}-${fields.propertyName}`);
      const ref = propsCol(waveId).doc(propId);
      const existing = await ref.get();
      if (existing.exists) {
        return json(res, 409, {
          error: `"${fields.propertyName}" is already in this wave. Reopen it from the list below if it needs changing.`
        });
      }

      await ref.set({
        waveId, rmSlug, fields,
        verified: false, touched: false,
        importedAt: new Date().toISOString(),
        addedByAdmin: true,
        history: []
      });
      await regCol(waveId).doc(rmSlug).set(
        { rmSlug, rmName: fields.rmName }, { merge: true });

      await waveDoc(waveId).set({
        propertyCount: (await propsCol(waveId).get()).size,
        regionalCount: (await regCol(waveId).get()).size,
        updatedAt: new Date().toISOString()
      }, { merge: true });

      const regional = await recomputeRegional(waveId, rmSlug);
      const stillNeeded = missingFields(fields);

      return json(res, 200, {
        ok: true,
        propertyId: propId,
        propertyName: fields.propertyName,
        rmName: fields.rmName,
        status: computeStatus({ fields, verified: false, touched: false }),
        stillNeeded,
        stillNeededLabels: stillNeeded.map(k => (FIELDS.find(f => f.key === k) || {}).label || k),
        regional
      });
    }

    if (action === 'recompute') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const regionals = await recomputeWave(waveId);
      return json(res, 200, { ok: true, regionals: regionals });
    }

    if (action === 'deleteWave') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const wSnap = await waveDoc(waveId).get();
      if (!wSnap.exists) return json(res, 404, { error: 'Wave not found.' });
      const name = wSnap.data().name || waveId;
      if (String(body.confirmName || '').trim() !== String(name).trim()) {
        return json(res, 400, { error: 'To delete this wave, type its exact name: ' + name });
      }
      await deleteAll(propsCol(waveId));
      await deleteAll(regCol(waveId));
      await waveDoc(waveId).delete();
      return json(res, 200, { ok: true, deleted: name });
    }

    return json(res, 400, { error: 'Unknown action "' + action + '".' });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
