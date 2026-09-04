const ExcelJS = require('exceljs');
const { waveDoc, propsCol, regCol } = require('./_lib/firebase');
const { FIELDS, computeStatus, missingFields, BY_KEY, isHidden } = require('./_lib/schema');
const { json, isAdmin, slug } = require('./_lib/util');

const STATUS_TEXT = {
  verified: 'Verified',
  ready: 'Awaiting confirmation',
  in_progress: 'In progress',
  needs_input: 'Not started'
};

module.exports = async (req, res) => {
  try {
    if (!isAdmin(req)) return json(res, 401, { error: 'Admin passcode required.' });
    const waveId = req.query && req.query.wave;
    if (!waveId) return json(res, 400, { error: 'wave is required.' });

    const wSnap = await waveDoc(waveId).get();
    if (!wSnap.exists) return json(res, 404, { error: 'Wave not found.' });
    const wave = wSnap.data();

    const [pSnap, rSnap] = await Promise.all([propsCol(waveId).get(), regCol(waveId).get()]);
    const props = pSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => {
        const an = String((a.fields || {}).rmName || ''), bn = String((b.fields || {}).rmName || '');
        if (an !== bn) return an.localeCompare(bn);
        return String((a.fields || {}).propertyName || '').localeCompare(String((b.fields || {}).propertyName || ''));
      });

    const wb = new ExcelJS.Workbook();
    wb.creator = 'RPM Property Verification';
    wb.created = new Date();

    // ---- Sheet 1: the data, in the original column order ----
    const ws = wb.addWorksheet(wave.name || waveId);
    const headers = FIELDS.map(f => f.sheetHeader)
      .concat(['Status', 'Missing Fields', 'Confirmed By', 'Confirmed At', 'Was Corrected']);
    ws.addRow(headers);

    for (const p of props) {
      const f = Object.assign({}, p.fields || {});
      // A property with no transition date of its own inherits the wave's.
      if (!f.transitionDate && wave.transitionDate) f.transitionDate = wave.transitionDate;
      const st = computeStatus(p);
      const miss = missingFields(f).map(k => (BY_KEY[k] || {}).label || k);
      const lastAction = (p.history || []).slice().reverse().find(h => h.action === 'confirmed' || h.action === 'corrected');
      ws.addRow(
        // "N/A" rather than a blank cell, so a question the answers made
        // inapplicable is not mistaken for one nobody got round to.
        FIELDS.map(fd => isHidden(f, fd) ? 'N/A' : (f[fd.key] == null ? '' : String(f[fd.key])))
          .concat([
            STATUS_TEXT[st] || st,
            miss.join('; '),
            p.verifiedBy || '',
            p.verifiedAt ? new Date(p.verifiedAt).toLocaleString('en-US') : '',
            lastAction && lastAction.action === 'corrected' ? 'Yes' : (p.verified ? 'No' : '')
          ])
      );
    }

    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2F4F' } };
    ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    ws.getRow(1).height = 58;
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: headers.length } };
    headers.forEach((h, i) => {
      const col = ws.getColumn(i + 1);
      const len = Math.max(String(h).length, ...props.map((p, r) => String(ws.getRow(r + 2).getCell(i + 1).value || '').length));
      col.width = Math.min(Math.max(len + 2, 12), 46);
    });

    // ---- Sheet 2: completion by Regional ----
    const ws2 = wb.addWorksheet('Progress by Regional');
    ws2.addRow(['Regional Manager', 'Properties', 'Verified', 'Outstanding', 'Complete?', 'Completed At', 'Still Outstanding']);
    rSnap.docs.map(d => d.data())
      .sort((a, b) => String(a.rmName || '').localeCompare(String(b.rmName || '')))
      .forEach(r => {
        ws2.addRow([
          r.rmName || '', r.total || 0, r.verified || 0, (r.total || 0) - (r.verified || 0),
          r.complete ? 'Yes' : 'No',
          r.completedAt ? new Date(r.completedAt).toLocaleString('en-US') : '',
          (r.outstanding || []).join('; ')
        ]);
      });
    ws2.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws2.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2F4F' } };
    ws2.views = [{ state: 'frozen', ySplit: 1 }];
    [34, 12, 10, 12, 11, 20, 70].forEach((w, i) => { ws2.getColumn(i + 1).width = w; });

    // ---- Sheet 3: audit trail of what changed ----
    const ws3 = wb.addWorksheet('Change Log');
    ws3.addRow(['Property', 'Regional', 'When', 'Who', 'Action', 'Field', 'Was', 'Changed To']);
    for (const p of props) {
      for (const h of (p.history || [])) {
        const when = h.at ? new Date(h.at).toLocaleString('en-US') : '';
        if (!h.changes || !h.changes.length) {
          ws3.addRow([(p.fields || {}).propertyName || p.id, (p.fields || {}).rmName || '', when, h.by || '', h.action || '', '', '', '']);
        } else {
          for (const c of h.changes) {
            ws3.addRow([(p.fields || {}).propertyName || p.id, (p.fields || {}).rmName || '', when, h.by || '', h.action || '', c.label || c.key, c.from || '', c.to || '']);
          }
        }
      }
    }
    ws3.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws3.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2F4F' } };
    ws3.views = [{ state: 'frozen', ySplit: 1 }];
    [30, 24, 20, 20, 12, 30, 34, 34].forEach((w, i) => { ws3.getColumn(i + 1).width = w; });

    const buf = await wb.xlsx.writeBuffer();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${slug(wave.name || waveId)}-${stamp}.xlsx"`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(buf));
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
};
