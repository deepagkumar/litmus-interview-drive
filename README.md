# .NET Interview Screening Drive

A self-contained, static technical screening test for .NET senior engineers/leads
(5+ years experience). No backend server required — hosted as a static page on
GitHub Pages, with submissions collected via a Google Apps Script Web App that
writes each candidate's results straight into a Google Drive folder.

## How it works

1. Candidate opens the page, enters name + email, and starts a 45-minute timer.
2. They answer 20 code-review / "spot the bug" style .NET questions in rich-text
   editors (with a lightweight formatting toolbar).
3. Tab switches and full-screen exits are tracked and included in the results.
4. On **Submit answers**, the page POSTs a self-contained HTML results file
   (candidate info + answers + focus-monitoring log) to a Google Apps Script
   Web App, which saves it into a Drive folder (and optionally logs an index
   row to a Google Sheet).
5. If submission fails 3 times in a row, a local "Download answers file"
   fallback button appears so the candidate can email the file manually as a
   backup.
6. On success, the page shows a simple thank-you / completion screen.

## Project structure

```
docs/
  index.html          # The full screening page — this is what GitHub Pages serves
apps-script/
  DriveUploadScript.gs  # Google Apps Script backend (paste into script.google.com)
```

`docs/` is used as the GitHub Pages source folder so the repo root can hold
other project files (this README, future question banks, etc.) without
cluttering what gets served.

## Setup

### 1. Deploy the Apps Script backend

1. Go to [script.google.com](https://script.google.com) → New project.
2. Paste in the contents of `apps-script/DriveUploadScript.gs`.
3. Set `FOLDER_ID` to the Drive folder where you want results saved (the ID
   is the string in the folder's URL after `/folders/`).
4. (Optional) Set `SHEET_ID` + `SHEET_NAME` if you also want an index row
   (timestamp, candidate name/email, file name, Drive link) logged per
   submission. Leave `SHEET_ID` empty to skip this.
5. **Deploy → New deployment → Web app**
   - Execute as: **Me**
   - Who has access: **Anyone**
6. Copy the resulting `/exec` URL.

### 2. Point the page at your deployment

In `docs/index.html`, find:

```js
const SCRIPT_URL = "...";
```

and paste in your `/exec` URL. (This repo currently has a real deployed URL
checked in — replace it with your own before reusing this for a different
screening round/Drive folder.)

### 3. Publish with GitHub Pages

1. Push this repo to GitHub.
2. Repo **Settings → Pages → Source**: deploy from branch `main`, folder `/docs`.
3. Share the resulting `https://<you>.github.io/<repo>/` URL with candidates.

## Notes / gotchas

- The Apps Script Web App runs under **your** Google account's permissions
  (`Execute as: Me`), so files always land in your Drive regardless of who
  the candidate is — no candidate-side login needed.
- The endpoint is effectively public once deployed (anyone with the URL can
  POST to it). Fine for a controlled interview drive; add a shared-secret
  check in the script if you want to lock it down further.
- The page force-reloads from the server on every visit (a one-time
  cache-busting redirect) so candidates always get the latest published
  version, even on hosts that don't let you set real `Cache-Control`
  response headers (like GitHub Pages).
- Closing/refreshing the page mid-screening clears answers — there's no
  autosave. This is intentional (matches the integrity model of the test)
  but worth knowing if you extend this.
- There is no server-side timer enforcement — the 45-minute limit is purely
  client-side (editors lock, but nothing stops a determined candidate from
  tampering with client JS). Treat this as a trust-based screening tool, not
  a proctored exam.

## Possible next steps for a "proper project"

- Parameterize the question bank (externalize questions to a JSON/YAML file
  instead of hardcoded HTML, so new rounds/tracks don't require editing markup).
- Add a build step (e.g. a small script that generates `docs/index.html` from
  a template + question data file) if you'll maintain multiple rounds/tracks.
- Add a basic shared-secret or per-candidate token check in the Apps Script
  to reduce spam/abuse of the public endpoint.
- Consider moving off Apps Script to Firebase/a small serverless function if
  you need real-time dashboards, per-candidate auth, or anti-tamper timing.
