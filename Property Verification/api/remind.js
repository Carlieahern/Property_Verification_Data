const { wavesCol, regCol } = require('./_lib/firebase');
const { json, readBody, isAdmin } = require('./_lib/util');
const { sendEmail, reminderEmail } = require('./_lib/email');
const { portfolioUrl } = require('./_lib/status');

// Vercel Cron sends "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set.
function cronAuthorised(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = req.headers['authorization'] || '';
  return auth === 'Bearer ' + secret;
}

function daysSince(iso) {
  if (!iso) return Infinity;
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

module.exports = async (req, res) => {
  try {
    const manual = isAdmin(req);
    if (!manual && !cronAuthorised(req)) return json(res, 401, { error: 'Not authorised.' });

    const body = req.method === 'POST' ? await readBody(req) : {};
    const onlyWave = body.waveId || (req.query && req.query.wave) || null;
    const onlyRm = body.rmSlug || null;
    const force = !!body.force;

    const wavesSnap = await wavesCol().get();
    const results = [];

    for (const wDoc of wavesSnap.docs) {
      const wave = wDoc.data();
      const waveId = wDoc.id;
      if (onlyWave && waveId !== onlyWave) continue;

      // The scheduled run only touches waves with reminders switched on.
      // A manual "send now" from the admin page passes force and bypasses that.
      if (!force) {
        if (wave.archived) continue;
        if (!wave.remindersOn) continue;
        if (!(Number(wave.reminderDays) > 0)) continue;
      }

      const every = Number(wave.reminderDays) || 0;
      const regs = await regCol(waveId).get();

      for (const rDoc of regs.docs) {
        const reg = rDoc.data();
        if (onlyRm && rDoc.id !== onlyRm) continue;
        if (reg.complete) continue;

        if (!reg.email) {
          results.push({ waveId, rmSlug: rDoc.id, rmName: reg.rmName, skipped: 'no email on file' });
          continue;
        }
        if (!force && daysSince(reg.lastReminderAt) < every) {
          results.push({ waveId, rmSlug: rDoc.id, rmName: reg.rmName, skipped: 'reminded recently' });
          continue;
        }

        const outcome = await sendEmail({
          to: reg.email,
          subject: 'Reminder: ' + (wave.name || waveId) + ' property details (' + (reg.verified || 0) + ' of ' + (reg.total || 0) + ' done)',
          html: reminderEmail({
            rmName: reg.rmName || rDoc.id,
            waveName: wave.name || waveId,
            done: reg.verified || 0,
            total: reg.total || 0,
            url: portfolioUrl(waveId, rDoc.id),
            missingProps: reg.outstanding || []
          }),
          kind: 'reminder',
          meta: { waveId, rmSlug: rDoc.id }
        });

        await rDoc.ref.set({
          lastReminderAt: new Date().toISOString(),
          reminderCount: (reg.reminderCount || 0) + 1
        }, { merge: true });

        results.push({ waveId, rmSlug: rDoc.id, rmName: reg.rmName, sent: outcome.status });
      }
    }

    return json(res, 200, { ok: true, ranAt: new Date().toISOString(), results });
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
