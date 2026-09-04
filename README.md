# Property Detail Verification

Gets property details confirmed by the Regional who owns them, one wave at a time,
ahead of each CRMiQ transition.

Live at **https://property-verification-data.vercel.app**

- **One link** for everyone, every wave. A person picks their name and sees each open
  wave that belongs to them, newest wave on top. Finished waves stay visible below.
- **Line by line.** Every field has its own *Correct* / *Needs fixing*. A property cannot
  be confirmed until each line has been actioned individually — there is no single button
  that waves the whole thing through.
- **Blanks must be filled.** Where nothing is on file there is nothing to verify, so the
  field is presented as required entry rather than something to confirm.
- **Signed per property.** A *Completed by* box at the end of each property, blank every
  time by design.
- **Confirmation is final.** Confirming locks the property, in the browser and on the
  server. The reviewer is told to message Carlie, who reopens it from the admin page.
- **No email.** Progress is tracked in the admin page, which lists who is still
  outstanding and lets you copy that list to chase people yourself.

---

## Everyday use

### Running a wave

1. **`/admin`** → passcode → *Start a new wave*
2. Name it (`Wave 6`), set the **due date** (verified by) and **transition date** (moves
   to CRMiQ), choose the file, *Import wave*
3. Send out the link from *Link to send out* — the same link every wave
4. Watch **Still outstanding**, and *Download Excel report* whenever you need the data

Waves order by the number in the name, so `Wave 6` sits above `Wave 5` for everyone.

### Chasing people

The admin page opens with **Still outstanding**: who has not finished, how many
properties are left, and which ones. Two buttons:

- **Copy names** — a semicolon-separated list for an email To: line
- **Copy names + properties** — the full breakdown, ready to paste into Teams or Outlook

### Corrections after confirmation

Confirming locks a property and the reviewer is told to message you. To action it:
`/admin` → **Reopen a confirmed property** → pick it → *Unlock*. It returns to their list
as unconfirmed.

### The Excel report

*Download Excel report* gives three sheets:

1. **The wave** — your original columns in their original order, plus Status, Missing
   Fields, Confirmed By, Confirmed At, Was Corrected
2. **Progress by Regional** — counts, complete yes/no, what is still outstanding
3. **Change Log** — every edit: property, who, when, field, old value, new value

---

## The import file

Headers are matched loosely (case and punctuation ignored), so the existing sheet works
as-is. A dropdown left as `-` counts as blank, so the Regional must answer it rather than
confirm a dash.

**Recognised columns** — Property Name · RM Name · Property Code · Revenue Management ·
Does the property use HappyCo? · Phone Landline Number · Do residents call maintenance
directly for emergencies? · If yes what is the number · Answering Service Provider ·
Directions to Forward · Directions to remove the forwarding · Office Hours · Completed by ·
CM/SM Name

**Optional** — `Transition Date` per property. Anything without one inherits the wave's.

**Office hours** can arrive either way, and both load into the day/time picker so the
Regional verifies real hours rather than a sentence.

The short form is the one to type:

```
M-F: 9-6, Sa: 10-4, Su: closed
M-F: 830-530, Sa: closed, Su: closed
```

- **Days** — `M` `T` `W` `R` (or `Th`) `F` `Sa` `Su`, singly or as a range (`M-F`, `M-Th`).
  `Weekdays`, `Weekend`, `Daily` and the long names all still work.
- **Times** — a bare hour (`9`), or hour and minutes with the colon implied
  (`830` = 8:30, `1730` = 17:30). `9:30`, `9am` and `09:00` are still accepted.
- **Closed** — the word `closed`.
- Opening times read as morning and closing times as afternoon, so `9-5` means
  9:00 AM to 5:00 PM. Use 24-hour (`1730`) or `am`/`pm` to be explicit.

Alternatively, per-day columns — `Monday Hours` … `Sunday Hours` holding `9-6` or
`closed`, or `Monday Open` + `Monday Close` pairs holding one time each.

Any day not mentioned is recorded as **Closed** — always shown back to the Regional to
confirm, so a wrong reading cannot slip through. The import result reports how many rows
loaded into the picker and how many stayed as plain text.

The HappyCo rule from the workbook is built in: when HappyCo is *Yes*, Answering Service
Provider becomes `HappyCo` and Directions to Forward becomes `Auto Forwards`, both locked.

### Re-importing a wave

Property records are keyed on property code + name, so re-importing never creates
duplicates. Pick a mode on the import form.

**Add or update** — the default, and safe to run as often as you like:

- properties in the file that are not in the wave yet are **added**
- properties nobody has confirmed have their **blanks filled in** from the file
- an answer somebody already typed is **never overwritten**
- properties that are already **confirmed are skipped entirely** — fields, signature and
  all — and the result tells you how many were left alone

So you can import a partial sheet now, let people start work, and re-import later with
more information filled in. Nothing anyone has signed off is disturbed.

**Replace** wipes the wave and rebuilds it from the file, losing every confirmation
collected so far. It asks first. Use it only to start a wave over.

A wave name that does not exist yet is simply created.

---

## Deployment

Hosted on Vercel, backed by its own Firebase project (`wave-verification`).

> The Firebase project is deliberately separate from `rpm-site-level-assumptions`. A
> service account key grants full access to every collection in its project, so this app
> has no credential path to live assumption data. `api/_lib/firebase.js` also keeps an
> allowlist and refuses any collection outside `pvWaves`.

### Environment variables

| Variable | Notes |
|---|---|
| `FIREBASE_PROJECT_ID` | from the service account JSON |
| `FIREBASE_CLIENT_EMAIL` | from the JSON |
| `FIREBASE_PRIVATE_KEY` | the whole `private_key` value, `\n` sequences intact |
| `ADMIN_KEY` | the `/admin` passcode |
| `PUBLIC_BASE_URL` | the deployed URL, used for the links shown in admin |

Paste them using Vercel's bulk *Import .env* box rather than one at a time — the private
key is a long single line and is easy to mangle by hand. **Environment variables only take
effect after a redeploy.**

### Changing the key

Generate a new key in Firebase → *Project settings → Service accounts*, then replace only
`FIREBASE_PRIVATE_KEY` and redeploy. The service account itself does not change.

`api/_lib/firebase.js` accepts the key with literal `\n`, with real newlines, with or
without surrounding quotes, and validates the PEM shape up front — a malformed key reports
itself instead of failing as an opaque `16 UNAUTHENTICATED`.

---

## Layout

```
index.html          reviewer page: pick your name, work through your properties
admin.html          import, outstanding list, settings, export, reopen, delete
vercel.json         clean URLs, so /admin works as well as /admin.html
api/
  schema.js         serves field definitions to the browser
  waves.js          wave list; Regionals merged across open waves
  portfolio.js      one Regional's properties, grouped by wave, newest first
  save.js           save / confirm, and the server-side lock
  import.js         create / merge / replace a wave from a spreadsheet
  export.js         builds the Excel report
  admin.js          dashboard, settings, reopen, delete
  _lib/
    schema.js       the 14 columns, completeness rules, office-hours parsing
    firebase.js     Firestore access, restricted to this app's own collection
    status.js       per-Regional roll-up
    util.js         shared helpers
```

Data lives under `pvWaves/{waveId}` with `properties` and `regionals` subcollections.

### Known gaps

- `ADMIN_KEY` is currently `admin`, which is guessable; `/admin` can delete a wave
