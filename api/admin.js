const { waveDoc, propsCol, regCol, getDb } = require('./_lib/firebase');
const { json, readBody, requireAdmin, slug } = require('./_lib/util');
const { recomputeWave, recomputeRegional, baseUrl } = require('./_lib/status');
const { FIELDS, EXTRA_KEYS, isBlank, parseHoursText, formatHours, canonicalizeAutoForward,
        missingFields, computeStatus, OWNER_CHAIN } = require('./_lib/schema');

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
        adminComplete: !!p.adminComplete,
        adminCompleteBy: p.adminCompleteBy || '',
        adminCompleteAt: p.adminCompleteAt || null,
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

      // Match the importer: an auto-forward answer sets the switch, not free text.
      canonicalizeAutoForward(after);

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

    // Email addresses for the Regionals. The tool never sends anything; these
    // exist so the outstanding list can be copied into Outlook in one go.
    if (action === 'setEmails') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const emails = (body.emails && typeof body.emails === 'object') ? body.emails : {};
      const entries = Object.entries(emails);
      if (!entries.length) return json(res, 400, { error: 'No addresses supplied.' });

      const db = getDb();
      for (let i = 0; i < entries.length; i += 400) {
        const batch = db.batch();
        for (const [rmSlug, addr] of entries.slice(i, i + 400)) {
          batch.set(regCol(waveId).doc(rmSlug), { email: String(addr || '').trim() }, { merge: true });
        }
        await batch.commit();
      }
      return json(res, 200, { ok: true, updated: entries.length });
    }

    // Mark work done without sending it back to a Regional -- for properties
    // that are finished in reality, such as ones confirmed under an earlier set
    // of questions, so nobody is asked to redo them.
    if (action === 'markComplete') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const scope = body.scope === 'regional' ? 'regional' : 'property';
      const by = String(body.by || '').trim() || 'Admin';
      const note = body.note ? String(body.note).slice(0, 300) : '';
      const now = new Date().toISOString();

      let targets = [];
      let rmSlug = body.rmSlug;
      if (scope === 'regional') {
        if (!rmSlug) return json(res, 400, { error: 'rmSlug is required.' });
        const snap = await propsCol(waveId).where('rmSlug', '==', rmSlug).get();
        targets = snap.docs;
      } else {
        if (!body.propertyId) return json(res, 400, { error: 'propertyId is required.' });
        const one = await propsCol(waveId).doc(body.propertyId).get();
        if (!one.exists) return json(res, 404, { error: 'Property not found.' });
        targets = [one];
        rmSlug = one.data().rmSlug;
      }

      const done = [], alreadyDone = [];
      for (const d of targets) {
        const prop = d.data();
        if (computeStatus(prop) === 'verified') {
          alreadyDone.push((prop.fields || {}).propertyName || d.id);
          continue;
        }
        const history = Array.isArray(prop.history) ? prop.history.slice(-49) : [];
        history.push({ at: now, by, action: 'admin_complete', note, changes: [] });
        await d.ref.set({
          adminComplete: true, adminCompleteAt: now, adminCompleteBy: by,
          adminCompleteNote: note, history
        }, { merge: true });
        done.push((prop.fields || {}).propertyName || d.id);
      }

      const regional = rmSlug ? await recomputeRegional(waveId, rmSlug) : null;
      return json(res, 200, { ok: true, scope, completed: done, alreadyComplete: alreadyDone, regional });
    }

    // Undo the above, putting the property back to whatever it genuinely is.
    if (action === 'unmarkComplete') {
      if (!waveId || !body.propertyId) return json(res, 400, { error: 'wave and propertyId are required.' });
      const uref = propsCol(waveId).doc(body.propertyId);
      const usnap = await uref.get();
      if (!usnap.exists) return json(res, 404, { error: 'Property not found.' });
      const uprop = usnap.data();
      if (!uprop.adminComplete) return json(res, 400, { error: 'That property was not marked complete by an admin.' });

      const uhist = Array.isArray(uprop.history) ? uprop.history.slice(-49) : [];
      uhist.push({ at: new Date().toISOString(), by: 'admin', action: 'admin_complete_removed', changes: [] });
      await uref.set({
        adminComplete: false, adminCompleteAt: null, adminCompleteBy: null,
        adminCompleteNote: null, history: uhist
      }, { merge: true });

      return json(res, 200, { ok: true, regional: await recomputeRegional(waveId, uprop.rmSlug) });
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

      canonicalizeAutoForward(fields);
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

    // When a Regional leaves part-way through a wave, hand their portfolio to
    // whoever picks it up, without reimporting. The properties, the position
    // that actually named them and the regional record all move together, so
    // anything already confirmed stays confirmed under the new owner.
    if (action === 'renameRegional') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const fromSlug = String(body.rmSlug || '').trim();
      const toName = String(body.newName || '').trim();
      if (!fromSlug) return json(res, 400, { error: 'rmSlug is required.' });
      if (!toName) return json(res, 400, { error: 'newName is required.' });

      const fromSnap = await regCol(waveId).doc(fromSlug).get();
      if (!fromSnap.exists) return json(res, 404, { error: 'No such Regional in this wave.' });
      const fromName = String(fromSnap.data().rmName || fromSlug);

      const toSlug = slug(toName);
      if (toSlug === fromSlug) return json(res, 400, { error: 'That is already their name.' });
      const clash = await regCol(waveId).doc(toSlug).get();
      if (clash.exists) {
        return json(res, 400, {
          error: 'This wave already has a Regional called ' + (clash.data().rmName || toName) +
                 '. Merging two portfolios is not something this can undo, so move the properties by hand.'
        });
      }

      // Omitting email leaves whatever is on file; sending one replaces it.
      const email = body.email === undefined ? null : String(body.email || '').trim();

      const db = getDb();
      const pSnap = await propsCol(waveId).where('rmSlug', '==', fromSlug).get();
      let moved = 0;
      for (let i = 0; i < pSnap.docs.length; i += 400) {
        const batch = db.batch();
        for (const d of pSnap.docs.slice(i, i + 400)) {
          const fields = Object.assign({}, d.data().fields || {});
          fields.rmName = toName;
          // Rewrite only the position that held the old name. Whoever owns the
          // property is worked out from these in order, so changing the wrong
          // one would hand it back to the person who left.
          for (const k of OWNER_CHAIN) {
            if (String(fields[k] || '').trim() === fromName) fields[k] = toName;
          }
          batch.set(d.ref, { rmSlug: toSlug, fields, updatedAt: new Date().toISOString() }, { merge: true });
          moved++;
        }
        await batch.commit();
      }

      const carried = Object.assign({}, fromSnap.data(), { rmSlug: toSlug, rmName: toName });
      if (email !== null) carried.email = email;
      await regCol(waveId).doc(toSlug).set(carried, { merge: true });
      await regCol(waveId).doc(fromSlug).delete();

      const regional = await recomputeRegional(waveId, toSlug);
      await recomputeWave(waveId);
      return json(res, 200, { ok: true, from: fromName, to: toName, rmSlug: toSlug, moved, regional });
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
