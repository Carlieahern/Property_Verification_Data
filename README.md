# Property Detail Verification

An internal tool for getting property details confirmed by the Regional who owns them,
one wave at a time, ahead of each CRMiQ transition.

- **One link** goes out to everyone. A person picks their name and sees every open
  wave that belongs to them, newest wave on top.
- **Line by line.** Each field has its own *Correct* / *Needs fixing* buttons. A property
  cannot be confirmed until every line has been actioned individually — there is no
  single button that waves the whole thing through.
- **Blanks must be filled.** Where nothing is on file there is nothing to verify, so the
  field is presented as required entry rather than as something to confirm.
- **Confirmation is final.** Confirming locks the property. The reviewer is told to
  message Carlie on Teams, and Carlie reopens it from the admin page.
- **Progress rolls up per Regional.** When someone's whole portfolio is done, Carlie gets
  an email.

---

## 1. What you need before deploying

| Thing | Why |
|---|---|
| A **new** Firebase project | Stores the answers. Must be its own project — see the warning below. |
| A Vercel account | Hosts the site and runs the daily reminder job. |
| A GitHub repo | How Vercel gets the code. |
| An email provider (optional, later) | Sends invites, reminders and completion alerts. |

> ### Do not point this at `rpm-site-level-assumptions`
> A service account key grants full read/write to **every** collection in its project.
> Pointing this tool at the project holding live assumption data would mean the only
> thing protecting that data is this app's code being careful. Use a separate Firebase
> project and there is no credential path to it at all.
>
> As a second line of defence, `api/_lib/firebase.js` refuses to touch any collection
> other than `pvWaves` and `pvEmailLog`.

---

## 2. Deploy

**a. Create the Firebase project**

1. <https://console.firebase.google.com> → *Add project* → name it e.g. `rpm-property-verification`.
2. *Build → Firestore Database → Create database* → **Production mode** → pick a region.
3. *Project settings → Service accounts → Generate new private key*. A `.json` file downloads.
   Keep it out of the repo — `.gitignore` already excludes `*firebase-adminsdk*.json`.

You do not need to write any security rules. The app only talks to Firestore from the
server using the service account, so the default locked-down rules are correct.

**b. Push the code**

```bash
git init && git add . && git commit -m "Property detail verification tool"
```

Then publish it to GitHub (GitHub Desktop → *Add existing repository* → *Publish*).

**c. Create the Vercel project**

Import the repo at <https://vercel.com/new>. No build settings to change — it is static
HTML plus serverless functions.

**d. Set the environment variables**

In Vercel → *Settings → Environment Variables*, add each of these (see `.env.example`):

| Variable | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | `project_id` from the service account JSON |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON, **including** the `-----BEGIN/END-----` lines and the `\n` escapes, wrapped in double quotes |
| `ADMIN_KEY` | A long passphrase you invent. This is the admin page passcode. |
| `NOTIFY_EMAIL` | Where portfolio-complete alerts go (your address) |
| `PUBLIC_BASE_URL` | Your deployed URL, e.g. `https://property-verification.vercel.app` |
| `CRON_SECRET` | Another long random string; protects the reminder endpoint |
| `EMAIL_PROVIDER` | `none` for now |

Redeploy after adding them.

**e. Check it**

Open `/admin`, enter your `ADMIN_KEY`, and import a spreadsheet.

---

## 3. Running a wave

1. **Import.** `/admin` → *Start a new wave* → name it (`Wave 6`), set the **due date**
   (when you need it verified) and the **transition date** (when the properties move to
   CRMiQ), choose the file, *Import wave*.
2. **Add email addresses** in the Regionals table, if you want invites and reminders.
   The link works fine without them.
3. **Send the link.** The same link every wave — copy it from *Link to send out*.
4. **Watch progress** on the admin dashboard, or *Download Excel report* at any time.

Waves are ordered by the number in the name, so `Wave 6` sits above `Wave 5` for
everyone. Earlier waves stay visible and unchanged underneath.

### The import file

Header names are matched loosely (case and punctuation are ignored), so your existing
sheet works as-is. A dropdown left as `-` is treated as blank, which means the Regional
has to answer it rather than confirm a dash.

**Recognised columns** — Property Name · RM Name · Property Code · Revenue Management ·
Does the property use HappyCo? · Phone Landline Number · Do residents call maintenance
directly for emergencies? · If yes what is the number · Answering Service Provider ·
Directions to Forward · Directions to remove the forwarding · Office Hours · Completed by ·
CM/SM Name

**Optional extras**

- `Transition Date` — per property. Anything without one inherits the wave's date.
- `RM Email` — enables invites and reminders for that Regional.

**Office hours** can arrive in either shape, and both load straight into the day/time
picker so the Regional verifies real hours rather than a sentence:

- a single `Office Hours` cell — `Mon-Fri 9am-6pm, Sat 10-4, Sun Closed`
  (also understands `Weekdays`, `Daily`, `Monday-Friday`, 24-hour times, and `8:30-5:30`)
- or per-day columns — `Monday Hours` … `Sunday Hours` (`9:00 AM-6:00 PM` or `Closed`),
  or `Monday Open` + `Monday Close` pairs.

Any day not mentioned is recorded as **Closed**. That guess is always shown back to the
Regional to confirm, so it cannot slip through unseen. The import result tells you how
many rows loaded into the picker and how many stayed as plain text.

The HappyCo rule from your workbook is built in: when HappyCo is *Yes*, Answering Service
Provider becomes `HappyCo` and Directions to Forward becomes `Auto Forwards`, both locked.

---

## 4. Email

Everything works with `EMAIL_PROVIDER=none` — messages are written to the `pvEmailLog`
collection and shown under *Recent email activity*, so you can confirm the logic is right
before anything is delivered. To switch delivery on:

**Resend** — sign up, verify a sending domain, then set `EMAIL_PROVIDER=resend`,
`RESEND_API_KEY=...`, `EMAIL_FROM="RPM Property Verification <verification@yourdomain.com>"`.

**SendGrid** — set `EMAIL_PROVIDER=sendgrid` and `SENDGRID_API_KEY=...` instead.

Three kinds of message are sent:

| When | To | Trigger |
|---|---|---|
| Invite | Regional | You click *Send invite email to everyone unfinished* |
| Reminder | Regional | Daily cron, if their portfolio is unfinished and they have not been reminded within the interval |
| Portfolio complete | You (`NOTIFY_EMAIL`) | Automatically, the first time a Regional finishes everything |

Reminders only go out for waves where *Send automatic reminders* is ticked and
*Remind every N days* is above zero. The cron runs daily at 13:00 UTC (~8am Central);
change the schedule in `vercel.json`.

---

## 5. Corrections after confirmation

Confirming locks a property, for the reviewer and on the server — a locked property
rejects further edits even if someone crafts the request by hand. The reviewer sees
*"Reach out to Carlie Ahern on Teams to make a correction."*

To action one: `/admin` → *Reopen a confirmed property* → pick it → *Unlock*. It returns
to the Regional's list as unconfirmed, and finishing again re-alerts you.

---

## 6. The Excel report

*Download Excel report* produces three sheets:

1. **The wave** — your original columns in their original order, plus Status, Missing
   Fields, Confirmed By, Confirmed At and Was Corrected.
2. **Progress by Regional** — counts, complete yes/no, and what is still outstanding.
3. **Change Log** — every edit: property, who, when, which field, old value, new value.

---

## 7. Layout

```
index.html          the reviewer page (pick your name, work through your properties)
admin.html          import, dashboard, email addresses, export, reminders, unlock
vercel.json         daily reminder cron
api/
  schema.js         serves the field definitions to the browser
  waves.js          wave list; merged Regionals across open waves
  portfolio.js      one Regional's properties, grouped by wave
  save.js           save / confirm, and the server-side lock
  import.js         creates a wave from a spreadsheet
  export.js         builds the Excel report
  remind.js         cron + manual reminders
  admin.js          dashboard, settings, invites, unlock, delete
  _lib/
    schema.js       the 14 columns, completeness rules, office-hours parsing
    firebase.js     Firestore access, restricted to this app's own collections
    email.js        provider adapter (resend / sendgrid / none) + templates
    status.js       per-Regional roll-up and the completion alert
    util.js         small shared helpers
```

Data lives under `pvWaves/{waveId}` with `properties` and `regionals` subcollections,
plus `pvEmailLog` for the email trail.
