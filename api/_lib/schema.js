// Single source of truth for the 14 Wave columns.
// `sheetHeader` is the EXACT header text from Carlie's workbook (typo included) so
// exports drop straight back into the existing process. `label` is what humans see.

const FIELDS = [
  { key: 'propertyName',      sheetHeader: 'Property Name',                                          label: 'Property Name',            type: 'text',     locked: true },
  { key: 'rmName',            sheetHeader: 'RM Name (RVP if no RM listed for the property)',         label: 'Regional Manager',         type: 'text',     locked: true },
  { key: 'propertyCode',      sheetHeader: 'Property Code',                                          label: 'Property Code',            type: 'text',     locked: true },
  // When this property moves to CRMiQ. Informational, never verified. Falls back
  // to the wave's transition date when the sheet does not carry a per-property one.
  { key: 'transitionDate',    sheetHeader: 'Transition Date',                                        label: 'Moving to CRMiQ on',       type: 'date',     locked: true },
  { key: 'revenueManagement', sheetHeader: 'Revenue Management',                                     label: 'Revenue Management',       type: 'yesno',    required: true },
  { key: 'happyCo',           sheetHeader: 'Does the property use HappyCo?',                         label: 'Does the property use HappyCo?', type: 'yesno', required: true },
  // sheetHeader keeps the workbook's original wording so exports still drop into
  // the existing process; only what the reviewer reads on screen has changed.
  { key: 'phoneLandline',     sheetHeader: 'Phone Landline Number',                                  label: 'Direct Phone Number',      type: 'tel',      required: true,
    notice: 'Verifying this number is critically important for this exercise. If this number is not correct, the outgoing calls for the team will not work. Several properties believe a tracking number is their direct line to the property. To verify with complete accuracy, please pick up office phone (if your phones have more than one line, complete this process using Line 1), and make an outgoing call manually to your cellphone. The number that reflects is the direct line for the property.' },
  { key: 'maintDirect',       sheetHeader: 'Do residents call mainteance directly for emergencies?', label: 'Do residents call maintenance directly for emergencies?', type: 'yesno', required: true },
  { key: 'maintNumber',       sheetHeader: 'If yes, what is the number',                             label: 'If yes, what is that number?', type: 'tel',
    requiredIf: { field: 'maintDirect', equals: 'Yes' },
    hiddenIf:   { field: 'maintDirect', equals: 'No' } },
  { key: 'answeringService',  sheetHeader: 'Answering Service Provider',                             label: 'Answering Service Provider', type: 'text', required: true,
    autoIf: { field: 'happyCo', equals: 'Yes', value: 'HappyCo' } },
  { key: 'directionsForward', sheetHeader: 'Directions to Forward',                                  label: 'Directions to Forward',    type: 'textarea', required: true,
    autoIf: { field: 'happyCo', equals: 'Yes', value: 'Auto Forwards' } },
  { key: 'directionsRemove',  sheetHeader: 'Directions to remove the forwarding',                    label: 'Directions to Remove the Forwarding', type: 'textarea', required: true },
  // Built with the day/time picker; the flat text value is what lands back in Excel.
  { key: 'officeHours',       sheetHeader: 'Office Hours',                                           label: 'Office Hours',             type: 'hours',    required: true,
    structKey: 'officeHoursStruct' },
  { key: 'completedBy',       sheetHeader: 'Completed by',                                           label: 'Completed by',             type: 'text',     system: true },
  { key: 'cmSmName',          sheetHeader: 'CM/SM Name',                                             label: 'CM / SM Name',             type: 'text',     required: true }
];

const BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));

// Stored alongside the sheet columns but not itself a column.
const EXTRA_KEYS = ['officeHoursStruct'];

// ---------------------------------------------------------------------------
// Office hours
// ---------------------------------------------------------------------------
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABEL = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY_FULL = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };

function parseHours(v) {
  if (!v) return null;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch (e) { return null; }
}

// Both editing modes collapse to the same seven-day shape.
function expandHours(struct) {
  if (!struct) return null;
  const blank = { closed: false, open: '', close: '' };
  const out = {};
  if (struct.mode === 'daily') {
    for (const d of DAY_KEYS) out[d] = Object.assign({}, blank, (struct.days || {})[d] || {});
  } else {
    const wd = Object.assign({}, blank, struct.weekdays || {});
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri']) out[d] = Object.assign({}, wd);
    out.sat = Object.assign({}, blank, struct.saturday || {});
    out.sun = Object.assign({}, blank, struct.sunday || {});
  }
  return out;
}

// Every day must be decided, and at least one day must actually be open.
function hoursComplete(struct) {
  const days = expandHours(struct);
  if (!days) return false;
  let anyOpen = false;
  for (const d of DAY_KEYS) {
    const v = days[d];
    if (!v) return false;
    if (v.closed) continue;
    if (!v.open || !v.close) return false;
    anyOpen = true;
  }
  return anyOpen;
}

function to12h(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return String(hhmm || '');
  let h = parseInt(m[1], 10);
  const suffix = h >= 12 ? 'PM' : 'AM';
  h = h % 12; if (h === 0) h = 12;
  return h + ':' + m[2] + ' ' + suffix;
}

// "Mon-Fri 9:00 AM-6:00 PM, Sat 10:00 AM-5:00 PM, Sun Closed"
function formatHours(struct) {
  const days = expandHours(struct);
  if (!days) return '';
  const sig = (d) => days[d].closed ? 'closed' : (days[d].open + '|' + days[d].close);
  const parts = [];
  let i = 0;
  while (i < DAY_KEYS.length) {
    let j = i;
    while (j + 1 < DAY_KEYS.length && sig(DAY_KEYS[j + 1]) === sig(DAY_KEYS[i])) j++;
    const span = i === j ? DAY_LABEL[DAY_KEYS[i]] : DAY_LABEL[DAY_KEYS[i]] + '-' + DAY_LABEL[DAY_KEYS[j]];
    const v = days[DAY_KEYS[i]];
    parts.push(span + ' ' + (v.closed ? 'Closed' : to12h(v.open) + '-' + to12h(v.close)));
    i = j + 1;
  }
  return parts.join(', ');
}

// Turn a seven-day map back into the compact struct the picker edits.
function structFromDays(days) {
  const same = ['tue', 'wed', 'thu', 'fri'].every(d =>
    days[d].closed === days.mon.closed && days[d].open === days.mon.open && days[d].close === days.mon.close);
  if (same) return { mode: 'grouped', weekdays: days.mon, saturday: days.sat, sunday: days.sun };
  return { mode: 'daily', days: days };
}

// ---- text parsing, used by the importer ----------------------------------
const DAY_TOKENS = {
  mon: 'mon', monday: 'mon', m: 'mon',
  tue: 'tue', tues: 'tue', tuesday: 'tue', t: 'tue',
  wed: 'wed', weds: 'wed', wednesday: 'wed', w: 'wed',
  thu: 'thu', thur: 'thu', thurs: 'thu', thursday: 'thu', th: 'thu', r: 'thu',
  fri: 'fri', friday: 'fri', f: 'fri',
  sat: 'sat', saturday: 'sat', sa: 'sat',
  sun: 'sun', sunday: 'sun', su: 'sun'
};

// Accepts 9, 9:30, 9am, 09:00 and the shorthand where the colon is implied:
// 830 -> 8:30, 1730 -> 17:30. One or two digits is a whole hour.
function parseTime(raw, role) {
  let s = String(raw || '').trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, '');
  if (!s) return null;
  const mer = s.match(/(am|pm)$/);
  if (mer) s = s.slice(0, -2).trim();

  let h, min;
  const withColon = s.match(/^(\d{1,2}):(\d{2})$/);
  if (withColon) {
    h = parseInt(withColon[1], 10);
    min = withColon[2];
  } else {
    const digits = s.match(/^(\d{1,4})$/);
    if (!digits) return null;
    const d = digits[1];
    if (d.length <= 2) { h = parseInt(d, 10); min = '00'; }
    else { h = parseInt(d.slice(0, d.length - 2), 10); min = d.slice(-2); }
  }

  if (parseInt(min, 10) > 59) return null;
  if (h > 24) return null;
  if (mer) {
    if (mer[1] === 'pm' && h < 12) h += 12;
    if (mer[1] === 'am' && h === 12) h = 0;
  } else if (h < 12 && role === 'close' && h >= 1 && h <= 8) {
    // No am/pm given: a closing time of 1-8 means the afternoon.
    h += 12;
  }
  if (h > 23) h = h % 24;
  return String(h).padStart(2, '0') + ':' + min;
}

function parseRange(text) {
  const s = String(text || '').trim();
  if (/closed|n\/?a|none/i.test(s)) return { closed: true, open: '', close: '' };
  const parts = s.split(/\s*(?:-|–|—|to|till|until|thru)\s*/i).filter(Boolean);
  if (parts.length < 2) return null;
  const open = parseTime(parts[0], 'open');
  const close = parseTime(parts[1], 'close');
  if (!open || !close) return null;
  return { closed: false, open: open, close: close };
}

function daysFromToken(token) {
  const t = String(token || '').trim().toLowerCase().replace(/\./g, '');
  if (!t) return [];
  if (/^(daily|everyday|every day|all week|7 ?days)$/.test(t)) return DAY_KEYS.slice();
  if (/^weekends?$/.test(t)) return ['sat', 'sun'];
  if (/^(weekdays?|business days?)$/.test(t)) return ['mon', 'tue', 'wed', 'thu', 'fri'];

  const range = t.split(/\s*(?:-|–|—|thru|through|to)\s*/).filter(Boolean);
  if (range.length === 2 && DAY_TOKENS[range[0]] && DAY_TOKENS[range[1]]) {
    const a = DAY_KEYS.indexOf(DAY_TOKENS[range[0]]);
    const b = DAY_KEYS.indexOf(DAY_TOKENS[range[1]]);
    const out = [];
    if (a <= b) { for (let i = a; i <= b; i++) out.push(DAY_KEYS[i]); }
    else { for (let i = a; i < DAY_KEYS.length; i++) out.push(DAY_KEYS[i]); for (let i = 0; i <= b; i++) out.push(DAY_KEYS[i]); }
    return out;
  }
  const single = t.split(/\s*[&+/]\s*|\s*,\s*/).map(x => DAY_TOKENS[x]).filter(Boolean);
  if (single.length) return single;
  return DAY_TOKENS[t] ? [DAY_TOKENS[t]] : [];
}

// Reads things like "Mon-Fri 9am-6pm, Sat 10-5, Sun Closed".
// Days never mentioned are treated as Closed. The Regional still confirms the
// result on screen, so a wrong reading cannot slip through unseen.
function parseHoursText(text) {
  const raw = String(text || '').trim();
  if (!raw || raw === '-') return null;

  const segments = raw.split(/\s*[;\n\r]\s*|\s*,\s*(?=[A-Za-z])/).map(s => s.trim()).filter(Boolean);
  const days = {};
  let matchedAny = false;

  for (const seg of segments) {
    const m = seg.match(/^([A-Za-z .,&+/–—-]+?)\s*[:\s]\s*(.+)$/);
    let dayPart, timePart;
    if (m) { dayPart = m[1]; timePart = m[2]; }
    else if (/closed/i.test(seg)) { dayPart = seg.replace(/closed/i, '').trim(); timePart = 'Closed'; }
    else { dayPart = ''; timePart = seg; }

    let targets = daysFromToken(dayPart);
    if (!targets.length && !dayPart) targets = DAY_KEYS.slice();   // a bare "9-6" means every day
    if (!targets.length) continue;

    const range = parseRange(timePart);
    if (!range) continue;
    matchedAny = true;
    for (const d of targets) days[d] = Object.assign({}, range);
  }

  if (!matchedAny) return null;
  for (const d of DAY_KEYS) if (!days[d]) days[d] = { closed: true, open: '', close: '' };
  if (!DAY_KEYS.some(d => !days[d].closed)) return null;
  return structFromDays(days);
}

// Builds hours from explicit per-day import columns, e.g. "Monday Hours",
// or "Monday Open" plus "Monday Close".
function parseHoursColumns(byDay) {
  const days = {};
  let any = false;
  for (const d of DAY_KEYS) {
    const cell = byDay[d];
    if (!cell) continue;
    let v = null;
    if (cell.range) v = parseRange(cell.range);
    else if (cell.open || cell.close) {
      if (/closed/i.test(String(cell.open || '') + ' ' + String(cell.close || ''))) v = { closed: true, open: '', close: '' };
      else {
        const o = parseTime(cell.open, 'open'), c = parseTime(cell.close, 'close');
        if (o && c) v = { closed: false, open: o, close: c };
      }
    }
    if (v) { days[d] = v; any = true; }
  }
  if (!any) return null;
  for (const d of DAY_KEYS) if (!days[d]) days[d] = { closed: true, open: '', close: '' };
  if (!DAY_KEYS.some(d => !days[d].closed)) return null;
  return structFromDays(days);
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

// Excel leaves unanswered dropdowns as "-", which must count as empty.
function isBlank(v) {
  if (v === undefined || v === null) return true;
  const s = String(v).trim();
  return s === '' || s === '-';
}

// The picker wins once it is filled in; otherwise imported text still counts,
// so hours already on file can simply be verified.
function officeHoursText(fields) {
  const struct = parseHours(fields.officeHoursStruct);
  if (struct && hoursComplete(struct)) return formatHours(struct);
  return isBlank(fields.officeHours) ? '' : String(fields.officeHours).trim();
}

// Value after applying the workbook's HappyCo formulas.
function effectiveValue(fields, field) {
  const f = typeof field === 'string' ? BY_KEY[field] : field;
  if (!f) return '';
  if (f.key === 'officeHours') return officeHoursText(fields);
  if (f.autoIf && String(fields[f.autoIf.field] || '').trim() === f.autoIf.equals) return f.autoIf.value;
  const v = fields[f.key];
  return isBlank(v) ? '' : String(v).trim();
}

function isHidden(fields, f) {
  return !!(f.hiddenIf && String(fields[f.hiddenIf.field] || '').trim() === f.hiddenIf.equals);
}

function isRequired(fields, f) {
  if (isHidden(fields, f)) return false;
  if (f.required) return true;
  if (f.requiredIf) return String(fields[f.requiredIf.field] || '').trim() === f.requiredIf.equals;
  return false;
}

// Which required fields are still empty. Empty array == ready to verify.
function missingFields(fields) {
  const out = [];
  for (const f of FIELDS) {
    if (f.locked || f.system) continue;
    if (!isRequired(fields, f)) continue;
    if (isBlank(effectiveValue(fields, f))) out.push(f.key);
  }
  return out;
}

// A property counts as done only when nothing is missing AND a person confirmed it.
function computeStatus(prop) {
  const missing = missingFields(prop.fields || {});
  if (missing.length === 0 && prop.verified) return 'verified';
  if (missing.length === 0) return 'ready';        // nothing blank, awaiting confirmation
  if (prop.touched) return 'in_progress';
  return 'needs_input';
}

module.exports = {
  FIELDS, BY_KEY, EXTRA_KEYS, DAY_KEYS, DAY_LABEL, DAY_FULL,
  isBlank, effectiveValue, isHidden, isRequired, missingFields, computeStatus,
  parseHours, expandHours, hoursComplete, formatHours, structFromDays,
  parseHoursText, parseHoursColumns, officeHoursText, to12h, parseTime, parseRange
};
