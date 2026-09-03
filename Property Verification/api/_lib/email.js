const { emailCol } = require('./firebase');
const { esc } = require('./util');

// Provider-agnostic sender. With EMAIL_PROVIDER=none nothing leaves the building,
// but every message is still written to the pvEmailLog collection so the wiring
// can be proven correct before a real provider is connected.
async function sendEmail({ to, subject, html, kind, meta }) {
  const provider = (process.env.EMAIL_PROVIDER || 'none').toLowerCase();
  const from = process.env.EMAIL_FROM || 'RPM Property Verification <onboarding@resend.dev>';
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);

  let status = 'logged_only';
  let error = null;

  if (!recipients.length) {
    status = 'skipped_no_recipient';
  } else if (provider === 'resend') {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ from, to: recipients, subject, html })
      });
      if (!r.ok) { status = 'failed'; error = `Resend ${r.status}: ${await r.text()}`; }
      else status = 'sent';
    } catch (e) { status = 'failed'; error = String(e && e.message || e); }
  } else if (provider === 'sendgrid') {
    try {
      const r = await fetch('https://api.sendgrid.com/v3/mail/send', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.SENDGRID_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          personalizations: [{ to: recipients.map(e => ({ email: e })) }],
          from: { email: (from.match(/<(.+)>/) || [null, from])[1], name: (from.split('<')[0] || '').trim() || undefined },
          subject,
          content: [{ type: 'text/html', value: html }]
        })
      });
      if (!(r.status >= 200 && r.status < 300)) { status = 'failed'; error = `SendGrid ${r.status}: ${await r.text()}`; }
      else status = 'sent';
    } catch (e) { status = 'failed'; error = String(e && e.message || e); }
  }

  try {
    await emailCol().add({
      to: recipients, subject, kind: kind || 'other', meta: meta || {},
      provider, status, error, at: new Date().toISOString(),
      bodyPreview: String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
    });
  } catch (e) { /* logging must never break the request */ }

  return { status, error };
}

function shell(title, bodyHtml) {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#1f2430">
  <div style="background:#0f2f4f;color:#fff;padding:18px 22px;border-radius:8px 8px 0 0">
    <div style="font-size:17px;font-weight:600">${esc(title)}</div>
  </div>
  <div style="border:1px solid #dfe4ec;border-top:none;border-radius:0 0 8px 8px;padding:22px">${bodyHtml}</div>
  <div style="color:#8894a8;font-size:12px;padding:14px 4px">Sent by the RPM Property Verification tool.</div>
</div>`;
}

function button(url, label) {
  return `<p style="margin:22px 0"><a href="${esc(url)}" style="background:#1a6dbf;color:#fff;text-decoration:none;padding:11px 20px;border-radius:6px;font-weight:600;display:inline-block">${esc(label)}</a></p>
  <p style="font-size:12px;color:#8894a8">Or paste this link into your browser:<br>${esc(url)}</p>`;
}

function reminderEmail({ rmName, waveName, done, total, url, missingProps }) {
  const list = (missingProps || []).slice(0, 12)
    .map(p => `<li style="margin:3px 0">${esc(p)}</li>`).join('');
  const more = (missingProps || []).length > 12 ? `<li style="color:#8894a8">…and ${missingProps.length - 12} more</li>` : '';
  return shell(`${waveName}: property details still needed`, `
    <p>Hi ${esc(rmName)},</p>
    <p>Your portfolio for <strong>${esc(waveName)}</strong> isn't finished yet — <strong>${done} of ${total}</strong> properties are verified.</p>
    <p style="margin-bottom:6px"><strong>Still outstanding:</strong></p>
    <ul style="margin-top:4px;padding-left:20px">${list}${more}</ul>
    ${button(url, 'Open my portfolio')}
    <p style="font-size:13px;color:#57627a">You can forward this link to your CM or SM if they're better placed to answer — the progress saves for everyone.</p>`);
}

function completionEmail({ rmName, waveName, total, url, completedAt }) {
  return shell(`${waveName} complete: ${rmName}`, `
    <p><strong>${esc(rmName)}</strong> has finished their entire portfolio for <strong>${esc(waveName)}</strong>.</p>
    <p>All <strong>${total}</strong> properties are verified as of ${esc(new Date(completedAt).toLocaleString('en-US'))}.</p>
    ${button(url, 'Review their submissions')}`);
}

function inviteEmail({ rmName, waveName, total, url, dueNote }) {
  return shell(`${waveName}: please verify your property details`, `
    <p>Hi ${esc(rmName)},</p>
    <p>Please review and confirm the property details for your portfolio — <strong>${total}</strong> ${total === 1 ? 'property' : 'properties'} in <strong>${esc(waveName)}</strong>.</p>
    <p>For each property you'll either confirm what's shown is correct, or correct it. Anything blank will need to be filled in.</p>
    ${dueNote ? `<p><strong>${esc(dueNote)}</strong></p>` : ''}
    ${button(url, 'Start reviewing')}
    <p style="font-size:13px;color:#57627a">Your progress saves automatically, and you can share the link with your CM or SM.</p>`);
}

module.exports = { sendEmail, reminderEmail, completionEmail, inviteEmail, shell, button };
