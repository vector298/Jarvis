import { h, icon, api, S, on, fmt, ago, bytes, kindBadge, toast, put } from '../util.js';
import { stageWithProgress } from '../console.js';
import { loading, emptyState, errorState } from './common.js';

const TYPE_NAME = { folder: 'Folder', pdf: 'PDF document', doc: 'Document', sheet: 'Spreadsheet', slides: 'Presentation', image: 'Image', video: 'Video', audio: 'Audio', archive: 'Archive', text: 'Text file', code: 'Source file', cad: 'CAD model', file: 'File' };
const typeName = (f) => (f.mimeType?.startsWith('application/vnd.google-apps.') && f.kind !== 'folder' ? `Google ${TYPE_NAME[f.kind] || 'file'}`.replace('Google Document', 'Google Doc') : TYPE_NAME[f.kind] || 'File');

export function createArchivePane() {
  const el = h('div.pane');
  const st = {
    mode: 'browse', folderId: 'root', crumbs: [{ id: 'root', name: 'My Drive' }], items: [],
    query: '', results: null, error: null, loaded: false, highlight: null, newFolder: false, syncedAt: null,
  };
  let u = null; // upload sheet state
  let sheetEl = null;
  let seq = 0;

  // ───── data
  async function browse(id = st.folderId, { quiet = false } = {}) {
    const mine = ++seq;
    if (!quiet && !st.loaded) put(el, bar(), h('div.pane-body', loading('Reading archive')));
    try {
      const d = await api(`/drive/list?folder=${encodeURIComponent(id)}`);
      if (mine !== seq) return;
      Object.assign(st, { mode: 'browse', folderId: d.folderId, crumbs: d.breadcrumbs, items: d.items, error: null, syncedAt: new Date() });
    } catch (err) {
      if (mine !== seq) return;
      st.error = err;
    }
    st.loaded = true;
    draw();
  }

  async function search(q) {
    const mine = ++seq;
    st.query = q;
    if (!q.trim()) return browse(st.folderId);
    st.mode = 'search';
    st.results = null;
    draw();
    try {
      const d = await api(`/drive/search?q=${encodeURIComponent(q)}`);
      if (mine !== seq) return;
      st.results = d;
      st.error = null;
      st.syncedAt = new Date();
    } catch (err) {
      if (mine !== seq) return;
      st.error = err;
    }
    st.loaded = true;
    draw();
  }

  // ───── listing
  function row(f, showLoc) {
    const isDir = f.kind === 'folder';
    const name = isDir
      ? h('button', { on: { click: () => { st.query = ''; browse(f.id); } } }, f.name)
      : h('a', { href: f.link, target: '_blank', rel: 'noopener', title: 'Open in Google Drive' }, f.name);
    return h('tr', { class: st.highlight === f.id ? 'fresh' : '', data: { id: f.id } },
      h('td.nm', h('div.fname', kindBadge(f.kind), name)),
      h('td.hm.num', typeName(f)),
      showLoc ? h('td.hm', h('div.loc', { title: f.folderPath }, f.folderId ? h('button.btn.sm', { style: 'height:20px;padding:0 6px;font-size:10px', on: { click: () => { st.query = ''; browse(f.folderId); } } }, f.folderPath) : f.folderPath)) : null,
      h('td.num', { title: f.modifiedTime ? fmt.full(f.modifiedTime) : '' }, f.modifiedTime ? ago(f.modifiedTime) : '—'),
      h('td.hm.num', isDir ? '' : bytes(f.size)),
      h('td', isDir ? null : h('a.iconbtn.sm', { href: f.link, target: '_blank', rel: 'noopener', 'aria-label': `Open ${f.name}`, title: 'Open' }, icon('external', 14))),
    );
  }

  function table(files, showLoc) {
    return h('table.files',
      h('thead', h('tr', h('th', 'Name'), h('th.hm', 'Type'), showLoc ? h('th.hm', 'Folder') : null, h('th', 'Modified'), h('th.hm', 'Size'), h('th', ''))),
      h('tbody', files.map((f) => row(f, showLoc))),
    );
  }

  function bar() {
    const q = h('input.input', { type: 'search', placeholder: 'Search the Archive…', value: st.query, 'aria-label': 'Search Drive', on: { keydown: (e) => { if (e.key === 'Enter') search(e.target.value); } } });
    return h('div.pane-bar',
      h('div.searchbox', icon('search', 14), q),
      st.mode === 'search' || st.query ? h('button.btn.sm', { on: { click: () => { st.query = ''; browse(st.folderId); } } }, 'Clear') : null,
      h('button.btn.sm', { on: { click: () => { st.newFolder = !st.newFolder; draw(); } } }, icon('folder', 12), 'New folder'),
      h('button.btn.primary.sm', { on: { click: () => openSheet() } }, icon('upload', 12), 'Upload'),
      h('button.iconbtn', { 'aria-label': 'Refresh', title: 'Refresh', on: { click: () => (st.mode === 'search' ? search(st.query) : browse(st.folderId, { quiet: true })) } }, icon('refresh', 15)),
    );
  }

  function folderRow() {
    if (!st.newFolder || st.mode === 'search') return null;
    const name = h('input.input', { placeholder: `New folder inside ${st.crumbs.at(-1).name}`, 'aria-label': 'Folder name', on: { keydown: (e) => { if (e.key === 'Enter') go(); if (e.key === 'Escape') { st.newFolder = false; draw(); } } } });
    const go = async () => {
      if (!name.value.trim()) return name.focus();
      try {
        await api('/drive/folders', { method: 'POST', body: { name: name.value.trim(), parentId: st.folderId, tz: S.tz } });
        st.newFolder = false;
        draw();
      } catch (err) { toast(err.message, 'err'); }
    };
    queueMicrotask(() => name.focus());
    return h('div.addrem', { style: 'grid-template-columns:1fr auto auto' }, name, h('button.btn.primary', { on: { click: go } }, 'Create'), h('button.btn', { on: { click: () => { st.newFolder = false; draw(); } } }, 'Cancel'));
  }

  function draw() {
    const body = h('div.pane-body');
    let head = null;
    if (st.error) body.append(errorState(st.error, { onRetry: () => (st.mode === 'search' ? search(st.query) : browse()), what: 'Archive link' }));
    else if (st.mode === 'search') {
      if (!st.results) body.append(loading(`Searching for “${st.query}”`));
      else {
        const r = st.results;
        const how = { name: 'matched on file name', content: 'matched on file contents', partial: 'no file contains every word; showing partial matches' }[r.mode];
        head = h('div.resultnote', icon('search', 14), h('span', h('b', `${r.files.length} ${r.files.length === 1 ? 'file' : 'files'}`), ` for “${st.query}” · ${how}`));
        body.append(r.files.length ? table(r.files, true) : emptyState({ glyph: 'search', title: 'Nothing found', text: `No file in the Archive matches “${st.query}”. Try fewer words, or a word from inside the document.` }));
      }
    } else {
      head = h('div.resultnote', { style: 'background:transparent' },
        h('div.crumbs', st.crumbs.flatMap((c, i) => [i ? h('span.sepr', '/') : null, h('button', { on: { click: () => browse(c.id) } }, c.name)])),
        h('span', { style: 'flex:1' }),
        st.syncedAt ? h('span.sync', `synced ${fmt.clock(st.syncedAt)}`) : null,
      );
      body.append(st.items.length ? table(st.items, false) : emptyState({ glyph: 'archive', title: 'Empty folder', text: 'Nothing here yet. Upload a document, or ask JARVIS to file one.' }));
    }
    put(el, bar(), folderRow(), head, body, sheetEl);
    el.querySelectorAll('tr.fresh').forEach((r) => r.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    if (st.highlight) setTimeout(() => { st.highlight = null; }, 3000);
  }

  // ───── upload sheet
  async function openSheet(hint = '') {
    u = { file: null, dest: 'existing', folderId: st.mode === 'browse' ? st.folderId : 'root', newName: '', parentId: 'root', folders: null, foldersError: null, phase: 'choose', pct1: 0, pct2: 0, label: '', jobId: null, result: null, error: null, hint };
    sheetEl = h('div.sheet');
    drawSheet();
    draw();
    try {
      u.folders = (await api('/drive/folders')).folders;
      if (hint) {
        const m = u.folders.find((f) => f.name.toLowerCase() === hint.toLowerCase()) || u.folders.find((f) => f.name.toLowerCase().includes(hint.toLowerCase()));
        if (m) { u.folderId = m.id; u.hintResolved = true; } else { u.dest = 'new'; u.newName = hint; }
      }
    } catch (err) { u.foldersError = err.message; }
    if (u) drawSheet();
  }

  function closeSheet() {
    u = null;
    sheetEl = null;
    draw();
  }

  const folderLabel = (id) => (id === 'root' ? 'My Drive' : u.folders?.find((f) => f.id === id)?.path || 'selected folder');

  function folderSelect(value, onChange, label) {
    const sel = h('select.select', { 'aria-label': label, on: { change: (e) => onChange(e.target.value) } },
      h('option', { value: 'root' }, 'My Drive'),
      (u.folders || []).map((f) => h('option', { value: f.id }, f.path.replace(/^My Drive \/ /, ''))),
    );
    sel.value = value;
    return sel;
  }

  async function send() {
    if (!u.file) return;
    if (u.dest === 'new' && !u.newName.trim()) { u.error = 'Name the new folder first.'; drawSheet(); return; }
    u.phase = 'sending';
    u.pct1 = 0;
    u.pct2 = 0;
    u.error = null;
    u.label = 'Transmitting to JARVIS';
    drawSheet();
    try {
      const staged = await stageWithProgress(u.file, (p) => { u.pct1 = p; paintBars(); });
      u.pct1 = 100;
      u.label = 'Filing in the Archive';
      drawSheet();
      const body = u.dest === 'new'
        ? { attachmentId: staged.id, newFolder: u.newName.trim(), parentId: u.parentId, folderLabel: folderLabel(u.parentId), tz: S.tz }
        : { attachmentId: staged.id, folderId: u.folderId, folderLabel: folderLabel(u.folderId), tz: S.tz };
      const job = await api('/drive/upload', { method: 'POST', body });
      u.jobId = job.id;
      // updates may have landed before we knew the id
      trackJob(S.jobs.get(job.id) || job);
    } catch (err) {
      u.phase = 'error';
      u.error = err.message;
      drawSheet();
    }
  }

  async function retryUpload() {
    try {
      u.phase = 'sending';
      u.error = null;
      u.pct2 = 0;
      drawSheet();
      const job = await api(`/jobs/${u.jobId}/retry`, { method: 'POST', body: { tz: S.tz } });
      u.jobId = job.id;
      trackJob(S.jobs.get(job.id) || job);
    } catch (err) {
      u.phase = 'error';
      u.error = err.message;
      drawSheet();
    }
  }

  on('job', (job) => trackJob(job));

  function trackJob(job) {
    if (!u || job.id !== u.jobId) return;
    const step = job.steps[0];
    if (step?.progress) { u.pct2 = step.progress.pct; u.label = step.progress.label || u.label; }
    if (job.state === 'done') {
      u.phase = 'done';
      u.pct2 = 100;
      u.result = { say: step?.say, link: step?.data?.links?.[0] };
      drawSheet();
    } else if (['failed', 'partial', 'cancelled'].includes(job.state)) {
      u.phase = 'error';
      u.error = step?.error?.message || job.reply || 'The upload did not complete.';
      u.errorCode = step?.error?.code;
      drawSheet();
    } else if (job.state === 'needs_input') {
      u.phase = 'error';
      u.error = job.reply;
      drawSheet();
    } else paintBars();
  }

  function paintBars() {
    if (!sheetEl) return;
    const a = sheetEl.querySelector('[data-bar="1"]');
    const b = sheetEl.querySelector('[data-bar="2"]');
    if (a) a.style.width = `${u.pct1}%`;
    if (b) b.style.width = `${u.pct2}%`;
    sheetEl.querySelectorAll('[data-p1]').forEach((n) => { n.textContent = `${u.pct1}%`; });
    sheetEl.querySelectorAll('[data-p2]').forEach((n) => { n.textContent = `${u.pct2}%`; });
  }

  function pickFile(file) {
    if (!file) return;
    u.file = file;
    u.error = null;
    drawSheet();
  }

  function stage(n, state, title, pct, key) {
    return h('div.stage', { class: state },
      h('span.ico', icon(state === 'done' ? 'check' : state === 'on' ? 'spin' : 'circle', 15, state === 'on' ? 'sp' : '')),
      h('span', title),
      state === 'on' || state === 'done' ? h('span.mono.dim', { [`data-p${key}`]: '' }, `${state === 'done' ? 100 : pct}%`) : null,
      state === 'on' || state === 'done' ? h('div.track', h('div.fill', { 'data-bar': String(key), style: `width:${state === 'done' ? 100 : pct}%` })) : null,
    );
  }

  function drawSheet() {
    if (!sheetEl) return;
    const body = h('div.sheet-body');
    const head = h('div.panel-head', h('span.title', 'File to the Archive'), h('span', { style: 'flex:1' }), h('button.iconbtn', { 'aria-label': 'Close', disabled: u.phase === 'sending', on: { click: closeSheet } }, icon('x', 16)));

    if (u.phase === 'choose' || u.phase === 'error' && !u.jobId) {
      const fileIn = h('input', { type: 'file', hidden: true, on: { change: (e) => pickFile(e.target.files[0]) } });
      if (u.hint) body.append(h('div.notice', { style: 'margin:0' }, icon('shield', 14), h('div.grow', u.dest === 'new' ? `You asked for “${u.hint}”, which doesn't exist yet. I've set it up as a new folder; change it if you like.` : `Destination preselected from your order: ${folderLabel(u.folderId)}.`)));
      body.append(u.file
        ? h('div.filecard', kindBadge(guessKind(u.file)), h('div.nm', u.file.name), h('span.mono.dim', bytes(u.file.size)), h('button.btn.sm', { on: { click: () => { u.file = null; drawSheet(); } } }, 'Change'))
        : h('div.drop', {
          on: {
            dragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
            dragleave: (e) => e.currentTarget.classList.remove('over'),
            drop: (e) => { e.preventDefault(); pickFile(e.dataTransfer.files[0]); },
          },
        }, icon('upload', 26), h('div', 'Drop a document here, or ', h('button.pick', { on: { click: () => fileIn.click() } }, 'choose one from this device')), h('span.faint', { style: 'font-size:12px' }, 'Anything: reports, schematics, notes, images.')),
        fileIn,
      );
      body.append(h('div.opt',
        h('span.label', 'Destination'),
        h('label.radio', h('input', { type: 'radio', name: 'dest', checked: u.dest === 'existing', on: { change: () => { u.dest = 'existing'; drawSheet(); } } }), 'Existing folder'),
        u.dest === 'existing' ? folderSelect(u.folderId, (v) => { u.folderId = v; }, 'Existing folder') : null,
        h('label.radio', h('input', { type: 'radio', name: 'dest', checked: u.dest === 'new', on: { change: () => { u.dest = 'new'; drawSheet(); } } }), 'New folder'),
        u.dest === 'new' ? [
          h('input.input', { placeholder: 'Folder name', value: u.newName, 'aria-label': 'New folder name', on: { input: (e) => { u.newName = e.target.value; } } }),
          h('div', { style: 'display:grid;gap:4px' }, h('span.faint', { style: 'font-size:12px' }, 'Create it inside'), folderSelect(u.parentId, (v) => { u.parentId = v; }, 'Parent folder')),
        ] : null,
        u.foldersError ? h('div.faint', { style: 'font-size:12px;color:var(--gold)' }, `Couldn't list your folders (${u.foldersError}). Uploading to My Drive still works.`) : null,
        !u.folders && !u.foldersError ? h('span.faint', { style: 'font-size:12px' }, 'Reading folders…') : null,
      ));
      if (u.error) body.append(h('div.result.fail', h('div.h', 'Not sent'), h('div', u.error)));
      body.append(h('div', { style: 'display:flex;gap:8px;justify-content:flex-end' },
        h('button.btn', { on: { click: closeSheet } }, 'Cancel'),
        h('button.btn.primary', { disabled: !u.file, on: { click: send } }, icon('upload', 12), 'Upload to Archive'),
      ));
    } else if (u.phase === 'sending') {
      body.append(
        h('div.filecard', kindBadge(guessKind(u.file)), h('div.nm', u.file.name), h('span.mono.dim', bytes(u.file.size))),
        h('div.stages',
          stage(1, u.pct1 >= 100 ? 'done' : 'on', 'Transmit to JARVIS', u.pct1, 1),
          stage(2, u.pct1 >= 100 ? 'on' : '', 'File in the Archive', u.pct2, 2),
        ),
        h('span.faint', { style: 'font-size:12px' }, `Destination: ${u.dest === 'new' ? `${folderLabel(u.parentId)} / ${u.newName}` : folderLabel(u.folderId)}`),
      );
    } else if (u.phase === 'done') {
      body.append(h('div.result',
        h('div.h', 'Archived'),
        h('div', u.result?.say || 'The document is in your Drive.'),
        h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          u.result?.link ? h('a.btn.primary', { href: u.result.link, target: '_blank', rel: 'noopener' }, icon('external', 12), 'Open in Drive') : null,
          h('button.btn', { on: { click: () => openSheet() } }, 'Upload another'),
          h('button.btn', { on: { click: closeSheet } }, 'Close'),
        ),
      ));
    } else {
      const reconnect = ['AUTH_EXPIRED', 'AUTH_SCOPE', 'NOT_CONNECTED'].includes(u.errorCode);
      body.append(
        h('div.filecard', kindBadge(guessKind(u.file)), h('div.nm', u.file.name), h('span.mono.dim', bytes(u.file.size))),
        h('div.result.fail', h('div.h', 'Upload failed'), h('div', u.error), h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' },
          reconnect ? h('a.btn.primary', { href: '/auth/google' }, 'Reconnect Google') : null,
          h('button.btn', { on: { click: retryUpload } }, icon('retry', 12), 'Try again'),
          h('button.btn', { on: { click: closeSheet } }, 'Close'),
        )),
      );
    }
    put(sheetEl, head, body);
  }

  const guessKind = (f) => (/pdf/i.test(f.type) ? 'pdf' : /image/.test(f.type) ? 'image' : /sheet|excel|csv/.test(f.type) ? 'sheet' : /presentation|powerpoint/.test(f.type) ? 'slides' : /word|document|rtf/.test(f.type) ? 'doc' : /zip|tar|gzip/.test(f.type) ? 'archive' : /text/.test(f.type) ? 'text' : 'file');

  on('open-upload', ({ folder }) => openSheet(folder || ''));

  put(el, bar(), h('div.pane-body', loading('Reading archive')));
  return {
    el,
    refresh: () => (st.mode === 'search' ? search(st.query) : browse(st.folderId, { quiet: true })),
    activate: () => (st.loaded ? browse(st.folderId, { quiet: true }) : browse()),
    focus({ folder, search: q, highlight }) {
      st.highlight = highlight || null;
      if (q) return search(q);
      st.query = '';
      return browse(folder || st.folderId);
    },
    openUpload: (folder) => openSheet(folder),
    badge: () => null,
  };
}
