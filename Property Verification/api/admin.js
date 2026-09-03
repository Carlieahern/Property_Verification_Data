const { waveDoc, propsCol, regCol, emailCol, getDb } = require('./_lib/firebase');
const { json, readBody, requireAdmin } = require('./_lib/util');
const { sendEmail, inviteEmail } = require('./_lib/email');
const { recomputeWave, recomputeRegional, portfolioUrl, baseUrl } = require('./_lib/status');

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

      let recentEmails = [];
      try {
        const logSnap = await emailCol().orderBy('at', 'desc').limit(25).get();
        recentEmails = logSnap.docs.map((d) => d.data());
      } catch (e) {
        recentEmails = [];
      }

      return json(res, 200, {
        wave: Object.assign({ id: wSnap.id }, wSnap.data()),
        regionals,
        baseUrl: baseUrl(),
        emailProvider: process.env.EMAIL_PROVIDER || 'none',
        notifyEmail: process.env.NOTIFY_EMAIL || null,
        recentEmails: recentEmails
      });
    }

    if (action === 'setEmails') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const emails = body.emails || {};
      const entries = Object.entries(emails);
      const db = getDb();
      for (let i = 0; i < entries.length; i += 400) {
        const batch = db.batch();
        for (const pair of entries.slice(i, i + 400)) {
          batch.set(regCol(waveId).doc(pair[0]), { email: String(pair[1] || '').trim() }, { merge: true });
        }
        await batch.commit();
      }
      return json(res, 200, { ok: true, updated: entries.length });
    }

    if (action === 'settings') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const patch = { updatedAt: new Date().toISOString() };
      if (body.reminderDays !== undefined) patch.reminderDays = Number(body.reminderDays) || 0;
      if (body.remindersOn !== undefined) patch.remindersOn = !!body.remindersOn;
      if (body.dueDate !== undefined) patch.dueDate = body.dueDate || null;
      if (body.transitionDate !== undefined) patch.transitionDate = body.transitionDate || null;
      if (body.archived !== undefined) patch.archived = !!body.archived;
      if (body.name) patch.name = String(body.name).trim();
      await waveDoc(waveId).set(patch, { merge: true });
      return json(res, 200, { ok: true, patch: patch });
    }

    if (action === 'invite') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const wSnap = await waveDoc(waveId).get();
      if (!wSnap.exists) return json(res, 404, { error: 'Wave not found.' });
      const wave = wSnap.data();

      const only = Array.isArray(body.rmSlugs) && body.rmSlugs.length ? new Set(body.rmSlugs) : null;
      const regs = await regCol(waveId).get();
      const results = [];

      let dueNote = '';
      if (wave.dueDate) {
        dueNote = 'Please complete by ' +
          new Date(wave.dueDate + 'T12:00:00').toLocaleDateString('en-US', { dateStyle: 'long' }) + '.';
      }

      for (const d of regs.docs) {
        const reg = d.data();
        if (only && !only.has(d.id)) continue;
        if (!reg.email) { results.push({ rmName: reg.rmName, skipped: 'no email on file' }); continue; }
        if (reg.complete && !body.includeComplete) { results.push({ rmName: reg.rmName, skipped: 'already complete' }); continue; }

        const outcome = await sendEmail({
          to: reg.email,
          subject: (wave.name || waveId) + ': please verify your property details',
          html: inviteEmail({
            rmName: reg.rmName || d.id,
            waveName: wave.name || waveId,
            total: reg.total || 0,
            url: portfolioUrl(waveId, d.id),
            dueNote: dueNote
          }),
          kind: 'invite',
          meta: { waveId, rmSlug: d.id }
        });

        await d.ref.set({ invitedAt: new Date().toISOString() }, { merge: true });
        results.push({ rmName: reg.rmName, sent: outcome.status });
      }
      return json(res, 200, { ok: true, results: results });
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

      // Clear the "already told Carlie" flag so finishing again alerts her afresh.
      await regCol(waveId).doc(prop.rmSlug).set({ notifiedAt: null }, { merge: true });

      const regional = await recomputeRegional(waveId, prop.rmSlug, { notify: false });
      return json(res, 200, {
        ok: true,
        reopened: (prop.fields || {}).propertyName || body.propertyId,
        regional
      });
    }

    if (action === 'recompute') {
      if (!waveId) return json(res, 400, { error: 'wave is required.' });
      const regionals = await recomputeWave(waveId, { notify: false });
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
