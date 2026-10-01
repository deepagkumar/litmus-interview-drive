# Litmus — Interview Drive Platform

Litmus is a lightweight, static platform for running timed technical screening tests ("interview
drives"). Any role, any language, as many drives as you like. No server to run: the pages
are hosted on GitHub Pages, and a Google Apps Script Web App stores drives and submissions
in your Google Drive.

- **Admins** (`admin.html`) create a drive: title, instructions, time limit, number of
  questions, and a question bank uploaded as JSON. They review a full candidate preview,
  then finalize it. The drive is saved as a JSON file in Google Drive.
- **Candidates** (`index.html`) enter their name and email, choose one of the open drives,
  and press Start. Only then are the questions loaded from Google Drive (through Apps
  Script) and the timer started.

## How it works

```
 admin.html ──(admin key)──┐                      Google Drive (ROOT_FOLDER_ID)
                           ├──► Apps Script ──►     drives/drive-<id>.json
 index.html ───────────────┘    Web App             submissions/<id>/<candidate>_<time>.html
                                                   (optional) Google Sheet index
```

**Candidate flow**

1. The page lists the drives that are **open**. A link like `index.html?drive=<id>`
   pre-selects one, which is handy for sending a link per drive.
2. Selecting a drive shows its details: title, role, question count, time limit, welcome
   text, instructions and notice.
3. On **Start**, the backend records a session (server start time plus assigned
   questions) and returns the questions. If the drive gives each candidate fewer questions
   than the bank holds, a random subset is picked on the server. Order is optionally
   shuffled. Candidates never receive the full bank or the evaluator notes.
4. The page renders the questions in rich-text answer boxes, goes full screen, starts the
   timer, and tracks tab switches and full-screen exits (same as before).
5. On **Submit answers**, a self-contained HTML results file is sent to the backend. The
   file holds candidate info, every question with its answer, the focus-monitoring log, and
   the raw data as embedded JSON. Before saving, the backend adds:
   - a **server verification** block: server-measured start, submit and elapsed time,
     flagged if over the limit (+2 min grace), if the email changed, or if it's a repeat
     submission;
   - the **evaluator notes** (`rubric`) for the questions this candidate received.
6. If submission fails 3 times, a "Download answers file" fallback appears.

**Admin flow**

1. Open `admin.html` and unlock it with the admin key (Apps Script property `ADMIN_KEY`).
2. **Drive list:** status, questions (per candidate / bank size), time and submission
   count. Hover over (or focus) any icon for a description of what it does:
   - **Edit**, **Close / Reopen**, **Copy candidate link**, **Download drive JSON**.
   - **Delete:** after you type `DELETE` to confirm, the drive file and its submissions
     folder are moved to Google Drive trash. You can restore them from the trash within
     30 days.
   - **Download results** (under the submission count) zips every submission for the drive,
     plus an `index.csv` with one row per candidate: time used, questions answered, focus
     events, and server verification status.
3. **New drive → Details & questions:** fill in the details and upload (or paste) the
   questions JSON. Any drive fields inside the file (title, time limit…) fill fields that
   are still empty.
4. **Review & finalize:** a summary plus every question rendered exactly as candidates
   see it, with evaluator notes shown. **Finalize & save to Drive** writes
   `drives/drive-<id>.json` and gives you the candidate link. Untick "Open for candidates"
   to save it closed.

## Project structure

```
docs/                         # GitHub Pages source folder
  index.html                  # Candidate page (template; content comes from the drive JSON)
  admin.html                  # Admin page
  assets/
    config.js                 # Backend URL + app name (shared by both pages)
    common.js                 # API client, question-file validation, question rendering
    app.css                   # Shared styles
    litmus-logo.svg           # Header logo
    favicon.svg               # Browser tab icon
  samples/
    dotnet-screening-round1.json  # The original 20 .NET questions, in the new format
apps-script/
  litmus-backend.gs           # Google Apps Script backend (paste into script.google.com)
```

## Setup

### 1. Deploy the Apps Script backend

1. Create a Google Drive folder for the platform. Its ID is the part of the folder URL
   after `/folders/`.
2. Go to [script.google.com](https://script.google.com) → New project, and paste in
   `apps-script/litmus-backend.gs`.
3. Set `ROOT_FOLDER_ID` to that folder's ID. The `drives/` and `submissions/` subfolders
   are created automatically.
4. **Project Settings → Script Properties → Add property:** `ADMIN_KEY` = a long random
   string (e.g. the output of `openssl rand -base64 24`). Admins type this to unlock
   `admin.html`. Keep it out of the repo.
5. (Optional) Set `SHEET_ID` (and `SHEET_NAME`) to log one row per submission: timestamp,
   drive, candidate, file link, verification status, server-measured minutes, notes.
6. **Deploy → New deployment → Web app.** Execute as: **Me**. Who has access: **Anyone**.
7. Copy the `/exec` URL.

> **Updating an existing deployment** (including moving from the old single-purpose
> `DriveUploadScript.gs`): paste the new code, then go to **Deploy → Manage deployments →
> Edit (pencil) → Version: New version → Deploy**. The `/exec` URL stays the same, so
> `config.js` doesn't need to change.

### 2. Point the pages at your deployment

Edit `docs/assets/config.js`:

```js
window.APP_CONFIG = {
  scriptUrl: "https://script.google.com/macros/s/…/exec",
  appName: "Litmus",
};
```

(This repo has a real deployment URL checked in. Replace it with your own if you reuse
this for a different Drive folder.)

### 3. Publish with GitHub Pages

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Source**: deploy from branch `main`, folder `/docs`.
3. The admin page is `https://<you>.github.io/<repo>/admin.html`. Give candidates
   `https://<you>.github.io/<repo>/`, or a per-drive link from the admin page.

### 4. Create your first drive

Open `admin.html` → **New drive** → upload `docs/samples/dotnet-screening-round1.json` →
**Review drive** → **Finalize & save to Drive**.

## Question file format

Upload either a bare array of questions, or an object with a `questions` array and any of
the optional drive fields:

```jsonc
{
  // optional drive fields: they prefill the admin form
  "title": "Java Backend Screening – Round 1",
  "role": "Senior Backend Engineer (5+ years)",
  "description": "Welcome text shown when the drive is selected.",
  "instructions": ["Assume Java 21.", "Do not run the code or use AI tools."],
  "notice": "**How your answers are evaluated:** …",
  "durationMinutes": 45,      // 1–300
  "questionCount": 10,        // per candidate; fewer than the bank = random subset each
  "shuffle": true,            // randomize order per candidate

  "questions": [
    {
      "id": "q1",             // optional (defaults to q1, q2, …); letters, digits, _ . -
      "title": "Spot the bug",
      "blocks": [             // rendered in order
        { "type": "text", "text": "This method is called from 200 threads:" },
        { "type": "code", "language": "java", "code": "public int next() {\n  return count++;\n}" },
        { "type": "list", "ordered": false, "items": ["Point one", "Point two"] },
        { "type": "table", "columns": ["#", "Scenario"], "rows": [["A", "Dedupe 2M ids"]] },
        { "type": "options", "items": ["`0`", "`1`", "It depends"] }   // shown as A. B. C.
      ],
      "ask": "What's wrong, and how would you fix it?",  // highlighted prompt at the end
      "rubric": "Non-atomic increment; use AtomicInteger."  // evaluator notes, never sent to candidates
    },
    {
      // shorthand: prompt / code / language / options instead of blocks
      "title": "Predict the output",
      "prompt": "What does this print?",
      "code": "print([1, 2] == list((1, 2)))",
      "language": "python",
      "ask": "Explain why."
    }
  ]
}
```

- Text fields support a small, safe subset of markdown: `` `code` ``, `**bold**`,
  `*italic*`, and `\*` to escape. A blank line starts a new paragraph. No raw HTML:
  everything is escaped.
- `language` drives syntax highlighting (highlight.js "common" set: `java`, `python`,
  `csharp`, `javascript`, `typescript`, `go`, `sql`, `kotlin`, `rust`, `cpp`, …). If
  highlight.js can't load, code shows as plain monospace.
- Every answer is free text in a rich-text box, including `options` questions.
- The admin page validates the file and lists every problem by question number before
  you can continue.

## Stored drive JSON

Each finalized drive is saved as `drives/drive-<id>.json`:

```jsonc
{
  "schemaVersion": 1,
  "id": "java-backend-screening-round-1-3f9a1c",
  "title": "…", "role": "…", "description": "…", "instructions": ["…"], "notice": "…",
  "durationMinutes": 45, "questionCount": 10, "shuffle": true,
  "status": "open",                   // "open" = visible to candidates, "closed" = hidden
  "createdAt": "…", "updatedAt": "…",
  "questions": [ /* normalized: every question has id, title, blocks[, ask][, rubric] */ ]
}
```

You can also edit these files directly in Drive. The public drive list is cached for 5
minutes, and saving through the admin page clears that cache immediately.

## Backend API

Every call is a `POST` to the `/exec` URL with a JSON body (sent as `text/plain` to avoid a
CORS preflight). Responses are `{ok: true, …}` or `{ok: false, error, code}`.

| Action | Who | Purpose |
| --- | --- | --- |
| `listDrives` | public | Open drives (details only, no questions) |
| `start` | public | `{driveId, candidateName, candidateEmail}` → session + assigned questions |
| `submit` | public | `{driveId, sessionId, candidateName, candidateEmail, htmlContent}` |
| `admin.listDrives` | admin key | All drives with status, bank size, submission counts |
| `admin.getDrive` | admin key | Full drive JSON, including rubrics |
| `admin.saveDrive` | admin key | Create (no `id`) or update (with `id`) a drive |
| `admin.setStatus` | admin key | `{driveId, status: "open" \| "closed"}` |
| `admin.downloadResults` | admin key | `{driveId}` → `{fileName, count, base64}`: zip of all submissions + `index.csv` (max 30 MB) |
| `admin.deleteDrive` | admin key | `{driveId, confirmId}` (`confirmId` must equal `driveId`) → trashes the drive and its submissions |

## Notes / gotchas

- The Web App runs as **you** (`Execute as: Me`), so everything lands in your Drive with
  no candidate login. Admin actions need `ADMIN_KEY`. The public actions can be called
  by anyone who has the URL, which is fine for a controlled drive.
- The admin key is kept in the browser's `sessionStorage` for the tab session only. **Lock**
  clears it.
- Questions are fetched only when a candidate presses Start, so they aren't visible in the
  page source beforehand. A candidate who starts can still see their own questions in
  devtools.
- The timer is still enforced client-side, but the backend now measures elapsed time from
  its own clock and flags late submissions in the results file and Sheet. Sessions live in
  Apps Script's cache for up to 6 hours, which is why time limits are capped at 300 minutes.
  A submission whose session has expired is saved but marked *Unverified*.
- Editing a drive affects only candidates who start after you save.
- Deleting uses Google Drive's trash rather than permanent deletion, so mistakes can be
  undone from Drive within 30 days. DriveApp lookups also return trashed items, so the
  backend explicitly ignores anything in the trash.
- **Download results** is limited to about 30 MB of submissions per zip, roughly a few hundred
  candidates. For bigger drives, download the files from the Drive folder directly.
- Closing or refreshing the page mid-screening clears answers. There's no autosave, by
  design.
- Both pages force a fresh load on every visit (a one-time cache-busting redirect).
  Shared assets are referenced with `?v=N`. Bump that number in `index.html` and
  `admin.html` when you change `assets/*`, so browsers don't reuse a cached copy for up
  to 10 minutes (GitHub Pages' cache lifetime).

## Possible next steps

- Track "started but never submitted" sessions in a Sheet tab.
- Prevent re-takes (one submission per email per drive).
- Opening/closing windows (`opensAt` / `closesAt`) per drive.
- Per-candidate invite tokens instead of open drive links.
- An admin view that lists submissions and renders them inline.
