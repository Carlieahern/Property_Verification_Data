const ExcelJS = require('exceljs');
const { FIELDS } = require('./_lib/schema');
const { json, isAdmin } = require('./_lib/util');

// A blank import sheet generated from the field definitions, so the columns can
// never drift from what the importer actually reads.

// Columns the sheet supplies that are not verifiable fields.
const EXTRA_COLUMNS = [
  { header: 'Tracking Numbers',
    note: 'Known tracking numbers for this property, separated by a comma and a space. Any of these typed as a phone number is rejected.' }
];

// What to write in the guidance row under each header.
function guidanceFor(f) {
  if (f.key === 'rmName') {
    return 'Leave blank — filled from Regional Manager, or Senior Regional Manager, or RVP.';
  }
  if (f.staff) {
    if (f.ownerRank === 1) return 'Who the portfolio is filed under. If blank, falls to Senior Regional Manager, then RVP.';
    if (f.ownerRank === 2) return 'Used as the owner only when Regional Manager is blank.';
    if (f.ownerRank === 3) return 'Used as the owner only when both Regional roles are blank.';
    return 'Optional. Shown with the property details.';
  }
  if (f.system) return 'Leave blank — filled in when the property is confirmed.';
  if (f.type === 'hours') {
    return 'Optional. e.g. M-F: 9-6, Sa: 10-4, Su: closed — 830 means 8:30. Blank means they set it.';
  }
  if (f.type === 'confirm') {
    return 'What we hold on file. The reviewer confirms it or corrects it.';
  }
  if (f.type === 'yesno') return 'Yes or No. Blank means the reviewer answers it.';
  if (f.type === 'choice') return 'One of: ' + (f.options || []).join(' | ') + '. Blank means the reviewer answers it.';
  if (f.key === 'propertyName') return 'Required.';
  if (f.key === 'propertyCode') return 'Strongly recommended — used to match on re-import.';
  if (f.key === 'transitionDate') return 'Optional. Blank inherits the date set for the wave.';
  return 'Optional. Blank means the reviewer has to supply it.';
}

module.exports = async (req, res) => {
  try {
    if (!isAdmin(req)) return json(res, 401, { error: 'Admin passcode required.' });

    const columns = FIELDS.map(f => ({
      header: f.sheetHeader,
      note: guidanceFor(f),
      required: f.key === 'propertyName'
    })).concat(EXTRA_COLUMNS.map(c => ({ header: c.header, note: c.note, required: false })));

    const wb = new ExcelJS.Workbook();
    wb.creator = 'RPM Property Verification';
    wb.created = new Date();

    const ws = wb.addWorksheet('Wave');
    ws.addRow(columns.map(c => c.header));
    ws.addRow(columns.map(c => c.note));

    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2F4F' } };
    ws.getRow(1).alignment = { vertical: 'middle', wrapText: true };
    ws.getRow(1).height = 62;

    // The guidance row is deleted before importing, so make that unmissable.
    ws.getRow(2).font = { italic: true, size: 10, color: { argb: 'FF8A5A00' } };
    ws.getRow(2).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDF3E0' } };
    ws.getRow(2).alignment = { vertical: 'top', wrapText: true };
    ws.getRow(2).height = 58;

    ws.views = [{ state: 'frozen', ySplit: 2 }];
    columns.forEach((c, i) => {
      ws.getColumn(i + 1).width = Math.min(Math.max(String(c.header).length + 4, 16), 40);
    });

    // A second sheet spelling out the rules that are easy to get wrong.
    const help = wb.addWorksheet('How to fill this in');
    const lines = [
      ['Delete row 2 before importing', 'Row 2 is guidance only. If it is left in, it imports as a property.'],
      ['One row per property', 'Property Name is the only column that must be filled.'],
      ['Anything left blank', 'Becomes a required question for the Regional. That is the point — blanks are safe.'],
      ['Who owns the property', 'Regional Manager, or Senior Regional Manager if that is blank, or RVP if both are. Leave the "RM Name" column blank.'],
      ['Dropdown answers', 'Leave blank, or use exactly Yes / No. A dash counts as blank.'],
      ['Office Hours', 'M-F: 9-6, Sa: 10-4, Su: closed. Three or four digits means an implied colon: 830 is 8:30, 1730 is 17:30.'],
      ['Tracking Numbers', 'Separated by a comma and a space. If a reviewer types one as a phone number it is rejected on the spot.'],
      ['Property Website / Email', 'What we hold today. The reviewer must open the website link before they can answer.'],
      ['Answering Service Provider', (FIELDS.find(f => f.key === 'answeringService').options || []).join(', ') + '. Anything else goes under Other.'],
      ['Does the property use EliseAI?', (FIELDS.find(f => f.key === 'eliseAI').options || []).join(', ') + '.'],
      ['Re-importing', 'Properties are matched on Property Code plus Property Name. "Add or update" never touches a confirmed property.']
    ];
    help.addRow(['Topic', 'What to know']);
    lines.forEach(l => help.addRow(l));
    help.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    help.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2F4F' } };
    help.getColumn(1).width = 34;
    help.getColumn(2).width = 104;
    help.getColumn(2).alignment = { wrapText: true, vertical: 'top' };
    help.views = [{ state: 'frozen', ySplit: 1 }];

    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="wave-import-template.xlsx"');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(Buffer.from(buf));
  } catch (e) {
    return json(res, 500, { error: String((e && e.message) || e) });
  }
};
