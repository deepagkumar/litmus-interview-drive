/**
 * Interview Drive backend — Google Apps Script Web App.
 *
 * Setup (see README for details):
 *   1. script.google.com > New project > paste this file.
 *   2. Set ROOT_FOLDER_ID below to the Drive folder that will hold everything.
 *   3. Project Settings > Script Properties > add ADMIN_KEY = <a long random string>.
 *      This is what admins type into admin.html. It is never sent to candidates.
 *   4. (Optional) Set SHEET_ID to also log one index row per submission.
 *   5. Deploy > New deployment > Web app — Execute as: Me, Who has access: Anyone.
 *      Copy the /exec URL into docs/assets/config.js.
 *      After editing this script later: Deploy > Manage deployments > Edit > New version
 *      (keeps the same URL).
 *
 * Layout created inside ROOT_FOLDER_ID:
 *   drives/drive-<id>.json            one JSON file per interview drive (details + question bank)
 *   submissions/<id>/<candidate>.html one self-contained results file per submission
 *
 * API: every call is a POST whose JSON body has an "action".
 *   Public: listDrives, start, submit
 *   Admin (body must include adminKey): admin.listDrives, admin.getDrive, admin.saveDrive, admin.setStatus
 * Responses: {ok:true, ...} or {ok:false, error, code}.
 */

const ROOT_FOLDER_ID = 'YOUR_DRIVE_FOLDER_ID_HERE';

// Optional: leave SHEET_ID empty ('') to skip Sheet logging entirely.
const SHEET_ID = '';
const SHEET_NAME = 'Submissions';

const GRACE_SECONDS = 120;             // allowed slack past the time limit before a submission is flagged
const SESSION_TTL_SECONDS = 21600;     // 6h, the CacheService maximum — so time limits are capped at 300 minutes
const MAX_DURATION_MINUTES = 300;
const LIST_CACHE_KEY = 'publicDrives';
const LIST_CACHE_SECONDS = 300;
const ID_RE = /^[a-z0-9][a-z0-9-]{2,79}$/;
const QID_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const BLOCK_TYPES = ['text', 'code', 'list', 'table', 'options'];

const PUBLIC_ACTIONS = {
  'listDrives': listDrives_,
  'start': start_,
  'submit': submit_
};
const ADMIN_ACTIONS = {
  'admin.listDrives': adminListDrives_,
  'admin.getDrive': adminGetDrive_,
  'admin.saveDrive': adminSaveDrive_,
  'admin.setStatus': adminSetStatus_
};

function doGet() {
  return json_({ ok: true, service: 'interview-drive' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '');
  } catch (err) {
    return json_({ ok: false, error: 'Request body must be JSON.' });
  }
  try {
    const action = String(req.action || '');
    if (PUBLIC_ACTIONS.hasOwnProperty(action)) return json_(Object.assign({ ok: true }, PUBLIC_ACTIONS[action](req)));
    if (ADMIN_ACTIONS.hasOwnProperty(action)) {
      requireAdmin_(req);
      return json_(Object.assign({ ok: true }, ADMIN_ACTIONS[action](req)));
    }
    return json_({ ok: false, error: 'Unknown action "' + action + '". Is the Apps Script deployment up to date?' });
  } catch (err) {
    if (!err.userMessage) console.error(err);
    return json_({ ok: false, error: err.userMessage || ('Server error: ' + err), code: err.code || '' });
  }
}

// ---------------------------------------------------------------- public actions

function listDrives_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(LIST_CACHE_KEY);
  if (hit) return { drives: JSON.parse(hit) };
  const drives = allDrives_().filter(function (d) { return d.status === 'open'; }).map(publicMeta_);
  try { cache.put(LIST_CACHE_KEY, JSON.stringify(drives), LIST_CACHE_SECONDS); } catch (e) { /* too large to cache: fine */ }
  return { drives: drives };
}

// Registers a server-side session (start time + assigned questions) and returns the questions.
// Questions are picked and ordered here, so candidates never receive the full bank or the rubrics.
function start_(req) {
  const drive = typeof req.driveId === 'string' && ID_RE.test(req.driveId) ? readDrive_(req.driveId) : null;
  if (!drive || drive.status !== 'open') fail_('This assessment is not open. Please refresh the page and choose another one.', 'not_open');
  const name = str_(req.candidateName, 120), email = str_(req.candidateEmail, 200);
  if (name.length < 2 || !EMAIL_RE.test(email)) fail_('Please enter your full name and a valid email address.');

  let idx = drive.questions.map(function (_, i) { return i; });
  shuffle_(idx);
  idx = idx.slice(0, Math.min(drive.questionCount, idx.length));
  if (!drive.shuffle) idx.sort(function (a, b) { return a - b; });
  const questions = idx.map(function (i) {
    const q = drive.questions[i];
    const out = { id: q.id, title: q.title, blocks: q.blocks };
    if (q.ask) out.ask = q.ask;
    return out;
  });

  const sessionId = Utilities.getUuid();
  CacheService.getScriptCache().put('session:' + sessionId, JSON.stringify({
    driveId: drive.id, name: name, email: email, startedAt: Date.now(),
    questionIds: questions.map(function (q) { return q.id; })
  }), SESSION_TTL_SECONDS);

  return { sessionId: sessionId, drive: publicMeta_(drive), questions: questions };
}

function submit_(req) {
  const name = str_(req.candidateName, 120), email = str_(req.candidateEmail, 200);
  if (!name || typeof req.htmlContent !== 'string' || !req.htmlContent) fail_('Missing candidate name or answers.');
  if (req.htmlContent.length > 10 * 1024 * 1024) fail_('The submission is too large.');

  const driveId = typeof req.driveId === 'string' && ID_RE.test(req.driveId) ? req.driveId : 'unknown-drive';
  const drive = driveId === 'unknown-drive' ? null : readDrive_(driveId);
  const cache = CacheService.getScriptCache();
  const sessionKey = 'session:' + String(req.sessionId || '').slice(0, 64);
  const rawSession = req.sessionId ? cache.get(sessionKey) : null;
  const session = rawSession ? JSON.parse(rawSession) : null;
  const v = verify_(session, drive, driveId, email);

  let html = req.htmlContent;
  html = insertAt_(html, '<!--SERVER-VERIFICATION-->', verificationHtml_(v), /<body[^>]*>/i);
  const qids = session ? session.questionIds : questionIdsFromHtml_(html);
  const rubric = drive ? rubricHtml_(drive, qids) : '';
  if (rubric) {
    const end = html.lastIndexOf('</body>');
    html = end === -1 ? html + rubric : html.slice(0, end) + rubric + html.slice(end);
  }

  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss');
  const fileName = slug_(name) + '_' + stamp + '.html';
  const file = submissionsFolder_(driveId, true).createFile(fileName, html, MimeType.HTML);

  if (session) {
    session.submittedAt = session.submittedAt || Date.now();
    cache.put(sessionKey, JSON.stringify(session), SESSION_TTL_SECONDS);
  }

  if (SHEET_ID) {
    const ss = SpreadsheetApp.openById(SHEET_ID);
    const sheet = ss.getSheetByName(SHEET_NAME) || ss.insertSheet(SHEET_NAME);
    if (sheet.getLastRow() === 0) {
      sheet.appendRow(['Timestamp', 'Drive ID', 'Drive Title', 'Candidate Name', 'Candidate Email', 'File Name', 'Drive Link',
                       'Verification', 'Minutes Used (server)', 'Notes']);
    }
    sheet.appendRow([new Date(), driveId, drive ? drive.title : '', name, email, fileName, file.getUrl(),
                     v.label, v.elapsedSeconds == null ? '' : Math.round(v.elapsedSeconds / 6) / 10, v.notes.join(' ')]);
  }
  return {};
}

// ---------------------------------------------------------------- admin actions

function requireAdmin_(req) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_KEY');
  if (!expected) fail_('ADMIN_KEY is not set. Add it under Project Settings > Script Properties in the Apps Script project.', 'not_configured');
  if (typeof req.adminKey !== 'string' || !safeEqual_(req.adminKey, expected)) {
    Utilities.sleep(800);   // slow down guessing
    fail_('Invalid admin key.', 'unauthorized');
  }
}

function adminListDrives_() {
  const subs = childFolder_(rootFolder_(), 'submissions', false);
  const drives = allDrives_().map(function (d) {
    const folder = subs ? childFolder_(subs, d.id, false) : null;
    let count = 0;
    if (folder) { const it = folder.getFiles(); while (it.hasNext()) { it.next(); count++; } }
    return Object.assign(publicMeta_(d), {
      status: d.status, shuffle: !!d.shuffle, bankSize: d.questions.length,
      createdAt: d.createdAt, updatedAt: d.updatedAt,
      submissionCount: count, folderUrl: folder ? folder.getUrl() : ''
    });
  });
  return { drives: drives };
}

function adminGetDrive_(req) {
  const drive = readDrive_(checkId_(req.driveId));
  if (!drive) fail_('Drive not found.');
  return { drive: drive };
}

function adminSaveDrive_(req) {
  const input = req.drive || {};
  const clean = sanitizeDrive_(input);
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  let saved;
  try {
    let existing = null;
    if (input.id) {
      existing = readDrive_(checkId_(input.id));
      if (!existing) fail_('Drive "' + input.id + '" no longer exists.');
    }
    const now = new Date().toISOString();
    saved = {
      schemaVersion: 1,
      id: existing ? existing.id : newId_(clean.title),
      title: clean.title, role: clean.role, description: clean.description,
      instructions: clean.instructions, notice: clean.notice,
      durationMinutes: clean.durationMinutes, questionCount: clean.questionCount, shuffle: clean.shuffle,
      status: input.status === 'closed' ? 'closed' : 'open',
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      questions: clean.questions
    };
    writeDrive_(saved);
  } finally {
    lock.releaseLock();
  }
  invalidateList_();
  return { drive: { id: saved.id, title: saved.title, status: saved.status } };
}

function adminSetStatus_(req) {
  if (req.status !== 'open' && req.status !== 'closed') fail_('Status must be "open" or "closed".');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const drive = readDrive_(checkId_(req.driveId));
    if (!drive) fail_('Drive not found.');
    drive.status = req.status;
    drive.updatedAt = new Date().toISOString();
    writeDrive_(drive);
  } finally {
    lock.releaseLock();
  }
  invalidateList_();
  return {};
}

// ---------------------------------------------------------------- validation

function sanitizeDrive_(d) {
  const title = str_(d.title, 200);
  if (!title) fail_('Drive title is required.');
  const duration = parseInt(d.durationMinutes, 10);
  if (!(duration >= 1 && duration <= MAX_DURATION_MINUTES)) fail_('Time limit must be between 1 and ' + MAX_DURATION_MINUTES + ' minutes.');
  if (!Array.isArray(d.questions) || !d.questions.length) fail_('At least one question is required.');
  if (d.questions.length > 500) fail_('A drive can have at most 500 questions.');

  const seen = {};
  const questions = d.questions.map(function (q, i) {
    const where = 'Question ' + (i + 1) + ': ';
    if (!q || typeof q !== 'object') fail_(where + 'must be an object.');
    const id = str_(q.id, 40);
    if (!QID_RE.test(id)) fail_(where + 'invalid id.');
    if (seen[id]) fail_(where + 'duplicate id "' + id + '".');
    seen[id] = true;
    const qtitle = str_(q.title, 300);
    if (!qtitle) fail_(where + 'title is required.');
    if (!Array.isArray(q.blocks)) fail_(where + 'blocks must be an array.');
    const blocks = q.blocks.map(function (b, j) { return sanitizeBlock_(b, where + 'block ' + (j + 1) + ': '); });
    const ask = str_(q.ask, 4000);
    if (!blocks.length && !ask) fail_(where + 'needs content or an ask.');
    const out = { id: id, title: qtitle, blocks: blocks };
    if (ask) out.ask = ask;
    const rubric = str_(q.rubric, 10000);
    if (rubric) out.rubric = rubric;
    return out;
  });

  const count = parseInt(d.questionCount, 10);
  if (!(count >= 1 && count <= questions.length)) fail_('Questions per candidate must be between 1 and ' + questions.length + '.');
  return {
    title: title,
    role: str_(d.role, 200),
    description: str_(d.description, 4000),
    instructions: (Array.isArray(d.instructions) ? d.instructions : []).slice(0, 50)
      .map(function (s) { return str_(s, 1000); }).filter(String),
    notice: str_(d.notice, 2000),
    durationMinutes: duration,
    questionCount: count,
    shuffle: d.shuffle === true,
    questions: questions
  };
}

function sanitizeBlock_(b, where) {
  if (!b || BLOCK_TYPES.indexOf(b.type) === -1) fail_(where + 'type must be one of ' + BLOCK_TYPES.join(', ') + '.');
  const strs = function (a, max) {
    if (!Array.isArray(a) || !a.length) fail_(where + 'needs a non-empty array.');
    return a.map(function (s) { return str_(s, max); });
  };
  switch (b.type) {
    case 'text':
      if (!str_(b.text, 20000)) fail_(where + 'text is required.');
      return { type: 'text', text: str_(b.text, 20000) };
    case 'code':
      if (typeof b.code !== 'string' || !b.code.trim()) fail_(where + 'code is required.');
      return { type: 'code', language: str_(b.language, 30).toLowerCase(), code: b.code.slice(0, 50000) };
    case 'list':
      return { type: 'list', ordered: b.ordered === true, items: strs(b.items, 4000) };
    case 'options':
      return { type: 'options', items: strs(b.items, 4000) };
    case 'table':
      return { type: 'table', columns: strs(b.columns, 500),
               rows: (Array.isArray(b.rows) ? b.rows : []).map(function (r) { return strs(r, 4000); }) };
  }
}

// ---------------------------------------------------------------- submission verification

function verify_(session, drive, driveId, email) {
  const v = { label: 'Verified', flag: false, notes: [], startedAt: null, elapsedSeconds: null, limitSeconds: drive ? drive.durationMinutes * 60 : null };
  if (!session) {
    v.label = 'Unverified';
    v.notes.push('No server session found (sessions expire after 6 hours), so the time used could not be checked.');
    return v;
  }
  v.startedAt = new Date(session.startedAt);
  v.elapsedSeconds = Math.round((Date.now() - session.startedAt) / 1000);
  if (session.driveId !== driveId) { v.flag = true; v.notes.push('Session was started for a different drive (' + session.driveId + ').'); }
  if (String(session.email).toLowerCase() !== String(email).toLowerCase()) { v.flag = true; v.notes.push('Email differs from the one used to start (' + session.email + ').'); }
  if (v.limitSeconds && v.elapsedSeconds > v.limitSeconds + GRACE_SECONDS) {
    v.flag = true;
    v.notes.push('Submitted ' + Math.round(v.elapsedSeconds / 60) + ' min after the server-recorded start; the limit is ' +
                 drive.durationMinutes + ' min (+' + GRACE_SECONDS / 60 + ' min grace). Possibly a slow/retried submission — check the client timestamps.');
  }
  if (session.submittedAt) { v.flag = true; v.notes.push('Repeat submission — this session already submitted at ' + new Date(session.submittedAt).toISOString() + '.'); }
  if (v.flag) v.label = 'Needs review';
  return v;
}

function verificationHtml_(v) {
  const tz = Session.getScriptTimeZone();
  const fmt = function (d) { return Utilities.formatDate(d, tz, 'yyyy-MM-dd HH:mm:ss z'); };
  const mins = function (s) { return Math.floor(s / 60) + ':' + ('0' + (s % 60)).slice(-2); };
  return '<section class="verify' + (v.flag || v.label === 'Unverified' ? ' flag' : '') + '"><h2>Server verification: ' + esc_(v.label) + '</h2><table>' +
    (v.startedAt ? '<tr><td>Server-recorded start</td><td>' + esc_(fmt(v.startedAt)) + '</td></tr>' : '') +
    '<tr><td>Server-recorded submission</td><td>' + esc_(fmt(new Date())) + '</td></tr>' +
    (v.elapsedSeconds != null ? '<tr><td>Elapsed (server clock)</td><td><strong>' + mins(v.elapsedSeconds) + '</strong>' +
      (v.limitSeconds ? ' of ' + mins(v.limitSeconds) : '') + '</td></tr>' : '') +
    '</table>' + (v.notes.length ? '<ul>' + v.notes.map(function (n) { return '<li>' + esc_(n) + '</li>'; }).join('') + '</ul>' : '') +
    '</section>';
}

function rubricHtml_(drive, qids) {
  const byId = {};
  drive.questions.forEach(function (q) { byId[q.id] = q; });
  const items = (qids || []).map(function (id, i) {
    const q = byId[id];
    if (!q || !q.rubric) return '';
    return '<div class="rubric"><strong>Question ' + (i + 1) + ': ' + esc_(q.title) + '</strong><br>' +
           esc_(q.rubric).replace(/\n/g, '<br>') + '</div>';
  }).join('');
  return items ? '<section><h2>Evaluator notes (from the drive, never shown to the candidate)</h2>' + items + '</section>' : '';
}

function questionIdsFromHtml_(html) {
  const m = html.match(/<script type="application\/json" id="screening-data">([\s\S]*?)<\/script>/);
  if (!m) return [];
  try {
    return (JSON.parse(m[1]).answers || []).map(function (a) { return String(a.questionId || ''); });
  } catch (e) {
    return [];
  }
}

// ---------------------------------------------------------------- storage

function rootFolder_() {
  if (!ROOT_FOLDER_ID || ROOT_FOLDER_ID.indexOf('YOUR_') === 0) fail_('ROOT_FOLDER_ID is not configured in the Apps Script.', 'not_configured');
  return DriveApp.getFolderById(ROOT_FOLDER_ID);
}

function childFolder_(parent, name, create) {
  const it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return create ? parent.createFolder(name) : null;
}

function drivesFolder_() { return childFolder_(rootFolder_(), 'drives', true); }

function submissionsFolder_(driveId, create) {
  const subs = childFolder_(rootFolder_(), 'submissions', create);
  return subs ? childFolder_(subs, driveId, create) : null;
}

function findDriveFile_(id) {
  const it = drivesFolder_().getFilesByName('drive-' + id + '.json');
  return it.hasNext() ? it.next() : null;
}

function readDrive_(id) {
  const f = findDriveFile_(id);
  return f ? JSON.parse(f.getBlob().getDataAsString('UTF-8')) : null;
}

function writeDrive_(drive) {
  const content = JSON.stringify(drive, null, 2);
  const f = findDriveFile_(drive.id);
  if (f) f.setContent(content);
  else drivesFolder_().createFile('drive-' + drive.id + '.json', content, 'application/json');
}

function allDrives_() {
  const out = [];
  const it = drivesFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (!/^drive-.+\.json$/.test(f.getName())) continue;
    try { out.push(JSON.parse(f.getBlob().getDataAsString('UTF-8'))); }
    catch (e) { console.warn('Skipping unreadable drive file ' + f.getName() + ': ' + e); }
  }
  out.sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
  return out;
}

function invalidateList_() { CacheService.getScriptCache().remove(LIST_CACHE_KEY); }

// ---------------------------------------------------------------- helpers

function publicMeta_(d) {
  return {
    id: d.id, title: d.title, role: d.role || '', description: d.description || '',
    instructions: d.instructions || [], notice: d.notice || '',
    durationMinutes: d.durationMinutes, questionCount: Math.min(d.questionCount, d.questions.length)
  };
}

function newId_(title) {
  const base = slug_(title, 'drive').slice(0, 40).replace(/-$/, '');
  return base + '-' + Utilities.getUuid().replace(/-/g, '').slice(0, 6);
}

function checkId_(id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) fail_('Invalid drive id.');
  return id;
}

function insertAt_(html, marker, snippet, fallbackRe) {
  const i = html.indexOf(marker);
  if (i !== -1) return html.slice(0, i) + snippet + html.slice(i + marker.length);
  const m = html.match(fallbackRe);
  if (m) return html.slice(0, m.index + m[0].length) + snippet + html.slice(m.index + m[0].length);
  return snippet + html;
}

function shuffle_(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

function str_(v, max) {
  if (typeof v === 'number') v = String(v);
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function slug_(s, fallback) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback || 'candidate';
}

function esc_(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function safeEqual_(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function fail_(message, code) {
  const e = new Error(message);
  e.userMessage = message;
  e.code = code || '';
  throw e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
