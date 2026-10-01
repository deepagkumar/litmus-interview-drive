// Shared helpers for the candidate and admin pages: backend calls, question-file
// validation/normalization, and rendering questions to HTML.
(function(){
  const cfg = window.APP_CONFIG || {};

  // ---------- backend ----------
  // Every call is a POST with a text/plain JSON body: text/plain avoids a CORS preflight,
  // and the Apps Script side JSON.parses the body. Responses are {ok:true, ...} or {ok:false, error}.
  async function api(action, payload, timeoutMs){
    if (!cfg.scriptUrl || cfg.scriptUrl.indexOf('PASTE_YOUR') !== -1) throw new Error('The backend URL is not configured (assets/config.js).');
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || 45000);
    let res;
    try {
      res = await fetch(cfg.scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action }, payload || {})),
        signal: ctl.signal
      });
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? 'The server took too long to respond.' : 'Could not reach the server. Check your connection.');
    } finally { clearTimeout(timer); }
    if (!res.ok) throw new Error('Server error (HTTP ' + res.status + ').');
    let data;
    try { data = await res.json(); } catch (e) { throw new Error('Unexpected response from the server. Is the Apps Script deployment up to date?'); }
    if (!data || data.ok !== true) { const err = new Error((data && data.error) || 'Request failed.'); err.code = data && data.code; throw err; }
    return data;
  }

  // ---------- text helpers ----------
  function esc(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

  // Minimal, safe inline markdown: `code`, **bold**, *italic*, and backslash escapes (\* \` \\).
  // Everything is HTML-escaped first, so question files can never inject markup.
  function inline(src){
    const parts = [];
    const s = String(src == null ? '' : src).replace(/\\([\\`*])|`([^`]+)`/g, (m, escd, code) => {
      parts.push(escd !== undefined ? esc(escd) : '<code>' + esc(code) + '</code>');
      return '\u0000' + (parts.length - 1) + '\u0000';
    });
    return esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      .replace(/\u0000(\d+)\u0000/g, (m, i) => parts[i]);
  }
  // Paragraphs split on blank lines; single newlines become <br>.
  function paragraphs(src, cls){
    return String(src == null ? '' : src).split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
      .map(p => '<p' + (cls ? ' class="' + cls + '"' : '') + '>' + p.split('\n').map(inline).join('<br>') + '</p>').join('');
  }
  function fmtClock(s){ s = Math.max(0, s); const m = Math.floor(s/60), r = s % 60; return String(m).padStart(2,'0') + ':' + String(r).padStart(2,'0'); }
  function plural(n, word){ return n + ' ' + word + (n === 1 ? '' : 's'); }

  // ---------- question file: validate + normalize ----------
  // Accepts either an array of questions or an object {questions:[...], ...optional drive fields}.
  // Returns {errors, questions, meta}; meta holds any drive-level fields found in the file.
  const BLOCK_TYPES = ['text', 'code', 'list', 'table', 'options'];
  const str = v => (typeof v === 'string' ? v.trim() : (typeof v === 'number' ? String(v) : ''));
  const isStrArr = a => Array.isArray(a) && a.every(x => typeof x === 'string' || typeof x === 'number');

  function normBlock(b, where, errors){
    if (!b || typeof b !== 'object') { errors.push(where + ': must be an object.'); return null; }
    if (BLOCK_TYPES.indexOf(b.type) === -1) { errors.push(where + ': "type" must be one of ' + BLOCK_TYPES.join(', ') + '.'); return null; }
    switch (b.type) {
      case 'text':
        if (!str(b.text)) { errors.push(where + ': text block needs "text".'); return null; }
        return { type: 'text', text: str(b.text) };
      case 'code':
        if (typeof b.code !== 'string' || !b.code.trim()) { errors.push(where + ': code block needs "code".'); return null; }
        return { type: 'code', language: str(b.language).toLowerCase(), code: b.code.replace(/\s+$/, '') };
      case 'list':
      case 'options':
        if (!isStrArr(b.items) || !b.items.length) { errors.push(where + ': ' + b.type + ' block needs a non-empty "items" array of strings.'); return null; }
        return b.type === 'list' ? { type: 'list', ordered: !!b.ordered, items: b.items.map(String) } : { type: 'options', items: b.items.map(String) };
      case 'table':
        if (!isStrArr(b.columns) || !Array.isArray(b.rows) || !b.rows.every(isStrArr)) { errors.push(where + ': table block needs "columns" (strings) and "rows" (arrays of strings).'); return null; }
        return { type: 'table', columns: b.columns.map(String), rows: b.rows.map(r => r.map(String)) };
    }
  }

  function normalizeDriveFile(raw){
    const errors = [], questions = [], meta = {};
    if (Array.isArray(raw)) raw = { questions: raw };
    if (!raw || typeof raw !== 'object') return { errors: ['The file must contain a JSON object or an array of questions.'], questions, meta };
    if (!Array.isArray(raw.questions) || !raw.questions.length) errors.push('Missing a non-empty "questions" array.');
    const ids = new Set();
    (Array.isArray(raw.questions) ? raw.questions : []).forEach((q, i) => {
      const where = 'Question ' + (i + 1);
      if (!q || typeof q !== 'object' || Array.isArray(q)) { errors.push(where + ': must be an object.'); return; }
      const title = str(q.title);
      if (!title) errors.push(where + ': "title" is required.');
      const blocks = [];
      if (q.blocks !== undefined) {
        if (!Array.isArray(q.blocks)) errors.push(where + ': "blocks" must be an array.');
        else q.blocks.forEach((b, j) => { const nb = normBlock(b, where + ', block ' + (j + 1), errors); if (nb) blocks.push(nb); });
      } else {
        // Shorthand form: prompt / code / options expand into blocks, in that order.
        const sh = [];
        if (q.prompt !== undefined) sh.push({ type: 'text', text: q.prompt });
        if (q.code !== undefined) sh.push({ type: 'code', language: q.language, code: q.code });
        if (q.options !== undefined) sh.push({ type: 'options', items: q.options });
        sh.forEach(b => { const nb = normBlock(b, where, errors); if (nb) blocks.push(nb); });
      }
      const ask = str(q.ask);
      if (!blocks.length && !ask) errors.push(where + ': needs "blocks", "prompt" or "ask".');
      const id = str(q.id) || ('q' + (i + 1));
      if (!/^[A-Za-z0-9_.-]{1,40}$/.test(id)) errors.push(where + ': "id" may only contain letters, digits, _ . - (max 40).');
      else if (ids.has(id)) errors.push(where + ': duplicate id "' + id + '".');
      ids.add(id);
      const out = { id, title, blocks };
      if (ask) out.ask = ask;
      if (str(q.rubric)) out.rubric = str(q.rubric);
      questions.push(out);
    });
    ['title', 'role', 'description', 'notice'].forEach(k => { if (str(raw[k])) meta[k] = str(raw[k]); });
    if (isStrArr(raw.instructions)) meta.instructions = raw.instructions.map(s => String(s).trim()).filter(Boolean);
    else if (str(raw.instructions)) meta.instructions = str(raw.instructions).split('\n').map(s => s.trim()).filter(Boolean);
    ['durationMinutes', 'questionCount'].forEach(k => { const n = parseInt(raw[k], 10); if (n > 0) meta[k] = n; });
    if (typeof raw.shuffle === 'boolean') meta.shuffle = raw.shuffle;
    return { errors, questions, meta };
  }

  // ---------- rendering ----------
  function renderBlocks(q){
    return q.blocks.map(b => {
      switch (b.type) {
        case 'text': return paragraphs(b.text);
        case 'code': return '<pre class="src"' + (b.language ? ' data-lang="' + esc(b.language.toUpperCase()) + '"' : '') + '><code' +
                            (b.language ? ' class="language-' + esc(b.language) + '"' : '') + '>' + esc(b.code) + '</code></pre>';
        case 'list': { const t = b.ordered ? 'ol' : 'ul'; return '<' + t + '>' + b.items.map(i => '<li>' + inline(i) + '</li>').join('') + '</' + t + '>'; }
        case 'options': return '<ul class="options">' + b.items.map((i, n) => '<li><strong>' + String.fromCharCode(65 + n) + '.</strong> ' + inline(i) + '</li>').join('') + '</ul>';
        case 'table': return '<div class="tbl"><table><thead><tr>' + b.columns.map(c => '<th>' + inline(c) + '</th>').join('') +
                             '</tr></thead><tbody>' + b.rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>';
      }
      return '';
    }).join('') + (q.ask ? '<p class="ask"><strong>Ask:</strong> ' + q.ask.split('\n').map(inline).join('<br>') + '</p>' : '');
  }

  function editorHtml(n, title){
    return '<div class="ans">' +
      '<label class="anslabel" for="ed' + n + '">Your answer</label>' +
      '<div class="toolbar" role="toolbar" aria-label="Formatting for question ' + n + '">' +
        '<button type="button" data-cmd="bold" title="Bold (Ctrl/Cmd+B)"><b>B</b></button>' +
        '<button type="button" data-cmd="italic" title="Italic (Ctrl/Cmd+I)"><i>I</i></button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-cmd="code" title="Inline code">&lt;/&gt;</button>' +
        '<button type="button" data-cmd="pre" title="Code block">{ }</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-cmd="insertUnorderedList" title="Bulleted list">• List</button>' +
        '<button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>' +
        '<span class="sep"></span>' +
        '<button type="button" data-cmd="clear" title="Clear formatting">Clear</button>' +
        '<span class="wc" id="wc' + n + '">0 words</span>' +
      '</div>' +
      '<div class="editor" id="ed' + n + '" contenteditable="true" role="textbox" aria-multiline="true" data-title="' + esc(title) +
        '" data-placeholder="Type your answer here. Use the toolbar for code, lists and emphasis."></div>' +
    '</div>';
  }

  // opts.answer: include the rich-text answer box. opts.label: extra text in the question kicker (e.g. the id in admin preview).
  function renderQuestion(q, n, opts){
    opts = opts || {};
    return '<section class="q" id="q' + n + '" data-n="' + n + '" data-qid="' + esc(q.id) + '">' +
      '<div class="qhead"><span class="qn">Question ' + n + (opts.label ? ' · ' + esc(opts.label) : '') + '</span><h2>' + esc(q.title) + '</h2></div>' +
      '<div class="qbody">' + renderBlocks(q) + '</div>' +
      (opts.answer ? editorHtml(n, q.title) : '') +
      (opts.rubric && q.rubric ? '<div class="rubric"><strong>Evaluator notes (never shown to candidates):</strong>' + paragraphs(q.rubric) + '</div>' : '') +
    '</section>';
  }

  // Syntax-highlight code blocks if highlight.js loaded; plain monospace otherwise.
  function highlight(root){
    if (!window.hljs) return;
    root.querySelectorAll('pre.src code[class*="language-"]').forEach(el => {
      const lang = (el.className.match(/language-(\S+)/) || [])[1];
      if (lang && window.hljs.getLanguage(lang)) { try { window.hljs.highlightElement(el); } catch (e) {} }
    });
  }

  window.App = { config: cfg, api, esc, inline, paragraphs, fmtClock, plural, normalizeDriveFile, renderBlocks, renderQuestion, highlight };
})();
