/* LeetCode Tracker - dashboard front-end. Vanilla JS, no build step. */

const state = {
  data: null,
  filters: { q: '', diff: 'all', status: 'all', topic: '', view: null },
  sort: { key: 'first_ac', dir: -1 },
  dismissedBanner: localStorage.getItem('lc_banner_dismissed') === '1',
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const STATUS_LABELS = {
  new: 'New',
  solid: 'Solid',
  revise: 'Revise',
  revisit: 'Revisit',
};

/* ------------------------------------------------------------------ api */

async function api(path, body) {
  const opts = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {};
  const res = await fetch(path, opts);
  return res.json();
}

let toastTimer = null;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = el('div', 'toast', msg);
  document.body.appendChild(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.remove(), 2200);
}

/* --------------------------------------------------------------- format */

function fmtDate(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
}

function fmtISO(iso) {
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return iso;
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: '2-digit' });
}

function relative(ts) {
  if (!ts) return '';
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

/* ----------------------------------------------------------- rendering */

function renderHeader(d) {
  const p = d.profile || {};
  const link = $('#profileLink');
  link.textContent = '@' + (d.username || '');
  link.href = `https://leetcode.com/u/${d.username}/`;
  $('#rankLine').textContent = p.ranking ? ` · rank #${p.ranking.toLocaleString()}` : '';

  const sync = d.sync || {};
  const dot = $('#syncDot');
  dot.className = 'dot' + (sync.running ? ' busy' : sync.last_error ? ' err' : '');
  let msg;
  if (sync.running) msg = sync.message + (sync.progress ? ` ${sync.progress}%` : '');
  else if (sync.last_error) msg = sync.message;
  else msg = sync.last_sync ? `synced ${relative(sync.last_sync)}` : 'never synced';
  $('#syncMsg').textContent = msg;
  $('#btnSync').disabled = !!sync.running;
}

function renderCards(d) {
  const s = d.stats;
  const bd = s.by_difficulty;
  const total = Math.max(1, s.tracked);
  const host = $('#cards');
  host.innerHTML = '';

  const solved = el('div', 'card');
  solved.innerHTML = `
    <div class="label">Tracked / Solved</div>
    <div class="value">${s.tracked}<small> / ${s.reported}</small></div>`;
  const bars = el('div', 'bars');
  [['Easy', bd.Easy, 'var(--easy)'], ['Medium', bd.Medium, 'var(--medium)'],
   ['Hard', bd.Hard, 'var(--hard)']].forEach(([, n, c]) => {
    const b = el('div', 'bar');
    b.style.flex = String(Math.max(n, 0.01));
    b.style.background = c;
    bars.appendChild(b);
  });
  solved.appendChild(bars);
  solved.appendChild(el('div', 'foot',
    `${bd.Easy} easy · ${bd.Medium} medium · ${bd.Hard} hard`));
  host.appendChild(solved);

  const mk = (label, value, foot, onClick, color) => {
    const c = el('div', 'card' + (onClick ? ' clickable' : ''));
    c.innerHTML = `<div class="label">${label}</div>
      <div class="value" ${color ? `style="color:${color}"` : ''}>${value}</div>
      <div class="foot">${foot}</div>`;
    if (onClick) c.onclick = onClick;
    return c;
  };

  host.appendChild(mk('Due for review', s.due, 'click to filter', () => {
    state.filters.view = state.filters.view === 'due' ? null : 'due';
    render();
  }, s.due ? 'var(--due)' : null));

  host.appendChild(mk('Unrated', s.unrated, 'set a confidence to schedule', () => {
    state.filters.view = state.filters.view === 'unrated' ? null : 'unrated';
    render();
  }));

  host.appendChild(mk('Need revisit', s.revisit, 'marked as shaky', () => {
    setStatusFilter('revisit');
  }));

  host.appendChild(mk('Starred', s.starred, 'click to filter', () => {
    state.filters.view = state.filters.view === 'starred' ? null : 'starred';
    render();
  }));

  const cal = d.calendar || {};
  host.appendChild(mk('Streak', cal.streak || 0,
    `${cal.active_days || 0} active days this year`));

  total; // keep lint quiet about the unused ratio helper
}

function renderBanner(d) {
  const host = $('#banner');
  host.innerHTML = '';
  const s = d.stats;
  const missing = s.reported - s.tracked;
  if (state.dismissedBanner || d.authenticated || missing <= 0) return;

  const b = el('div', 'banner');
  b.innerHTML = `
    <div>
      <b>${s.tracked} of ${s.reported} solved problems imported.</b>
      LeetCode only exposes your last 20 accepted submissions publicly, so the
      other ${missing} need a one-time backfill with your session cookie
      (it stays on this machine). New solves get picked up automatically either way.
    </div>`;
  const btn = el('button', 'primary', 'How to backfill');
  btn.onclick = showBackfillModal;
  const x = el('span', 'x', '✕');
  x.onclick = () => {
    state.dismissedBanner = true;
    localStorage.setItem('lc_banner_dismissed', '1');
    render();
  };
  b.appendChild(btn);
  b.appendChild(x);
  host.appendChild(b);
}

function visibleRows() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  let rows = state.data.problems.filter((r) => {
    if (f.diff !== 'all' && r.difficulty !== f.diff) return false;
    if (f.status !== 'all' && r.status !== f.status) return false;
    if (f.topic && !r.topics.includes(f.topic)) return false;
    if (f.view === 'due' && !r.due) return false;
    if (f.view === 'starred' && !r.starred) return false;
    if (f.view === 'unrated' && !r.unrated) return false;
    if (q) {
      const hay = (r.title + ' ' + r.slug + ' ' + r.topics.join(' ') + ' ' +
                   r.note + ' ' + r.qid).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const { key, dir } = state.sort;
  const order = { Easy: 1, Medium: 2, Hard: 3, Unknown: 4 };
  const statusOrder = { revisit: 1, revise: 2, new: 3, solid: 4 };
  rows.sort((a, b) => {
    let x = a[key], y = b[key];
    if (key === 'difficulty') { x = order[x] || 9; y = order[y] || 9; }
    if (key === 'status') { x = statusOrder[x] || 9; y = statusOrder[y] || 9; }
    if (key === 'title') return dir * String(x).localeCompare(String(y));
    x = x == null ? -Infinity : x;
    y = y == null ? -Infinity : y;
    if (typeof x === 'string' || typeof y === 'string') {
      return dir * String(x).localeCompare(String(y));
    }
    return dir * (x - y);
  });
  return rows;
}

function renderTable() {
  const tbody = $('#rows');
  const rows = visibleRows();
  tbody.innerHTML = '';
  const empty = $('#emptyState');
  empty.innerHTML = '';

  if (!rows.length) {
    const total = state.data.problems.length;
    const e = el('div', 'empty');
    e.innerHTML = total
      ? `<h3>No problems match these filters</h3><div>Try clearing the search or filters.</div>`
      : `<h3>Nothing imported yet</h3><div>Hit <b>Sync now</b>, or use <b>Add manually</b> to paste in problems you've already solved.</div>`;
    empty.appendChild(e);
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) frag.appendChild(renderRow(r));
  tbody.appendChild(frag);

  $('#countLine').textContent =
    `Showing ${rows.length} of ${state.data.problems.length} tracked problems` +
    (state.data.stats.catalog ? ` · catalog: ${state.data.stats.catalog} problems` : '');

  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    const old = th.querySelector('.arrow');
    if (old) old.remove();
    if (th.dataset.sort === state.sort.key) {
      th.appendChild(el('span', 'arrow', state.sort.dir === 1 ? '▲' : '▼'));
    }
  });
}

function renderRow(r) {
  const tr = el('tr');
  if (r.due) tr.classList.add('due-row');

  // star
  const tdStar = el('td');
  const star = el('span', 'star' + (r.starred ? ' on' : ''), r.starred ? '★' : '☆');
  star.title = 'Star this problem';
  star.onclick = () => patch(r, { starred: r.starred ? 0 : 1 });
  tdStar.appendChild(star);
  tr.appendChild(tdStar);

  // id
  tr.appendChild(el('td', 'qid', r.qid || '—'));

  // title
  const tdTitle = el('td', 'title-cell');
  const a = el('a', null, r.title);
  a.href = r.url;
  a.target = '_blank';
  a.rel = 'noreferrer';
  tdTitle.appendChild(a);
  if (r.paid_only) tdTitle.appendChild(el('span', 'ext', '🔒'));
  tdTitle.appendChild(el('span', 'ext', '↗'));
  tr.appendChild(tdTitle);

  // difficulty
  tr.appendChild(el('td', 'diff ' + r.difficulty, r.difficulty));

  // topics
  const tdTopics = el('td', 'hide-sm');
  const box = el('div', 'topics');
  r.topics.slice(0, 3).forEach((t) => {
    const tag = el('span', 'tag', t);
    tag.onclick = () => { state.filters.topic = t; $('#topicFilter').value = t; render(); };
    box.appendChild(tag);
  });
  if (r.topics.length > 3) {
    const more = el('span', 'tag', `+${r.topics.length - 3}`);
    more.title = r.topics.slice(3).join(', ');
    box.appendChild(more);
  }
  tdTopics.appendChild(box);
  tr.appendChild(tdTopics);

  // solved date
  const solvedTxt = fmtDate(r.first_ac);
  const tdSolved = el('td', 'date' + (solvedTxt ? '' : ' none'), solvedTxt || 'backfilled');
  tdSolved.title = solvedTxt
    ? `${r.ac_count} accepted submission(s) seen`
    : 'Imported without a date (LeetCode only dates recent submissions)';
  tr.appendChild(tdSolved);

  // status
  const tdStatus = el('td');
  const sel = el('select', 'status s-' + r.status);
  Object.entries(STATUS_LABELS).forEach(([v, label]) => {
    const o = el('option', null, label);
    o.value = v;
    if (v === r.status) o.selected = true;
    sel.appendChild(o);
  });
  sel.onchange = () => patch(r, { status: sel.value });
  tdStatus.appendChild(sel);
  tr.appendChild(tdStatus);

  // confidence
  const tdConf = el('td');
  const conf = el('div', 'conf');
  for (let i = 1; i <= 5; i++) {
    const dot = el('i', i <= r.confidence ? 'on' : '');
    dot.title = `Confidence ${i}/5`;
    dot.onclick = () => patch(r, { confidence: r.confidence === i ? 0 : i });
    conf.appendChild(dot);
  }
  tdConf.appendChild(conf);
  tr.appendChild(tdConf);

  // last revised
  const revTxt = fmtISO(r.last_revised);
  const tdRev = el('td', 'date hide-sm' + (revTxt ? '' : ' none'), revTxt || '—');
  if (r.revise_count) tdRev.title = `Revised ${r.revise_count} time(s)`;
  tr.appendChild(tdRev);

  // next review
  const nextTxt = fmtISO(r.next_review);
  const tdNext = el('td', 'date' + (r.due ? ' due' : nextTxt ? '' : ' none'),
    r.due ? 'due now' : nextTxt || (r.unrated ? 'rate it' : 'mastered'));
  tdNext.title = nextTxt
    ? 'Scheduled for ' + nextTxt
    : r.unrated
      ? 'Set a confidence (or hit Revised) to start scheduling this one'
      : 'Confident — no review scheduled';
  tr.appendChild(tdNext);

  // note
  const tdNote = el('td');
  const input = el('input', 'note');
  input.type = 'text';
  input.value = r.note;
  input.placeholder = 'approach, pitfalls, pattern…';
  input.dataset.slug = r.slug;
  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => patch(r, { note: input.value }, true), 700);
  };
  input.onblur = () => { clearTimeout(timer); patch(r, { note: input.value }, true); };
  tdNote.appendChild(input);
  tr.appendChild(tdNote);

  // revised button
  const tdAct = el('td');
  const btn = el('button', 'rev-btn', 'Revised');
  btn.title = 'Mark as revised today and push out the next review';
  btn.onclick = async () => {
    await api('/api/revised', { slug: r.slug });
    toast(`Marked "${r.title}" revised today`);
    refresh();
  };
  tdAct.appendChild(btn);
  tr.appendChild(tdAct);

  return tr;
}

/* ------------------------------------------------------------- actions */

async function patch(row, fields, quiet) {
  Object.assign(row, fields);
  await api('/api/note', Object.assign({ slug: row.slug }, fields));
  if (!quiet) refresh();
  else renderCardsOnly();
}

function renderCardsOnly() {
  // Recompute the derived counters without rebuilding the table (keeps focus).
  const rows = state.data.problems;
  state.data.stats.starred = rows.filter((r) => r.starred).length;
  state.data.stats.revisit = rows.filter((r) => r.status === 'revisit').length;
  renderCards(state.data);
}

function setStatusFilter(value) {
  state.filters.status = value;
  document.querySelectorAll('#statusPills .pill').forEach((p) =>
    p.classList.toggle('on', p.dataset.status === value));
  render();
}

function render() {
  if (!state.data) return;
  renderHeader(state.data);
  renderCards(state.data);
  renderBanner(state.data);
  renderTable();
  document.querySelectorAll('#viewPills .pill').forEach((p) =>
    p.classList.toggle('on', p.dataset.view === state.filters.view));
}

async function refresh() {
  const active = document.activeElement;
  const keepFocus = active && active.classList.contains('note')
    ? { slug: active.dataset.slug, pos: active.selectionStart } : null;

  state.data = await api('/api/state');
  fillTopics(state.data.topics);
  render();

  if (keepFocus) {
    const again = document.querySelector(`input.note[data-slug="${keepFocus.slug}"]`);
    if (again) {
      again.focus();
      again.setSelectionRange(keepFocus.pos, keepFocus.pos);
    }
  }
}

function fillTopics(topics) {
  const sel = $('#topicFilter');
  if (sel.dataset.n === String(topics.length)) return;
  sel.dataset.n = String(topics.length);
  const cur = sel.value;
  sel.innerHTML = '<option value="">All topics</option>';
  topics.forEach((t) => {
    const o = el('option', null, t);
    o.value = t;
    sel.appendChild(o);
  });
  sel.value = cur;
}

/* -------------------------------------------------------------- modals */

function modal(node) {
  const bg = el('div', 'modal-bg');
  const box = el('div', 'modal');
  box.appendChild(node);
  bg.appendChild(box);
  bg.onclick = (e) => { if (e.target === bg) bg.remove(); };
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { bg.remove(); document.removeEventListener('keydown', esc); }
  });
  $('#modalHost').appendChild(bg);
  return bg;
}

function showBackfillModal() {
  const box = el('div');
  box.innerHTML = `
    <h2>Import everything you've already solved</h2>
    <p>LeetCode's public API only shows your last 20 accepted submissions. To pull
    in your full history once, the tracker needs your own session cookie. It is
    stored in <code>secrets.json</code> next to this app, is only ever sent to
    leetcode.com, and never leaves your machine.</p>
    <ol>
      <li>Open <code>leetcode.com</code> in your browser, signed in.</li>
      <li>Press <b>F12</b> → <b>Application</b> tab → <b>Cookies</b> → <code>https://leetcode.com</code>.</li>
      <li>Copy the <b>Value</b> of the <code>LEETCODE_SESSION</code> row (it's long).</li>
      <li>Paste it into <code>secrets.json</code> so the file reads:<br>
        <code>{ "LEETCODE_SESSION": "paste-here" }</code></li>
      <li>Come back and press <b>Sync now</b> — every solved problem appears.</li>
    </ol>
    <p style="color:var(--faint)">The cookie is a login token: don't commit
    <code>secrets.json</code> to git (a <code>.gitignore</code> is already set up
    for it) and re-paste it if it expires.</p>`;
  const row = el('div', 'row');
  const close = el('button', null, 'Got it');
  const bg = modal(box);
  close.onclick = () => bg.remove();
  row.appendChild(close);
  box.appendChild(row);
}

function showManualModal() {
  const box = el('div');
  box.innerHTML = `
    <h2>Add solved problems manually</h2>
    <p>Paste LeetCode URLs or problem slugs, one per line. Difficulty, topics and
    the problem number get filled in automatically.</p>`;
  const ta = el('textarea');
  ta.placeholder =
    'https://leetcode.com/problems/two-sum/\nvalid-parentheses\nmerge-intervals';
  box.appendChild(ta);
  const row = el('div', 'row');
  const cancel = el('button', null, 'Cancel');
  const add = el('button', 'primary', 'Add');
  row.appendChild(cancel);
  row.appendChild(add);
  box.appendChild(row);
  const bg = modal(box);
  cancel.onclick = () => bg.remove();
  add.onclick = async () => {
    const entries = ta.value.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!entries.length) return bg.remove();
    add.disabled = true;
    add.textContent = 'Adding…';
    const res = await api('/api/manual', { entries });
    bg.remove();
    toast(`Added ${res.added} problem(s) — fetching details…`);
    setTimeout(refresh, 1200);
    refresh();
  };
  ta.focus();
}

/* ---------------------------------------------------------------- wire */

function init() {
  $('#btnSync').onclick = async () => {
    await api('/api/sync', { full: false });
    toast('Sync started');
    setTimeout(refresh, 600);
  };
  $('#btnManual').onclick = showManualModal;

  $('#search').oninput = (e) => { state.filters.q = e.target.value; renderTable(); };

  $('#diffPills').onclick = (e) => {
    const p = e.target.closest('.pill');
    if (!p) return;
    state.filters.diff = p.dataset.diff;
    document.querySelectorAll('#diffPills .pill').forEach((x) => x.classList.remove('on'));
    p.classList.add('on');
    renderTable();
  };

  $('#statusPills').onclick = (e) => {
    const p = e.target.closest('.pill');
    if (p) setStatusFilter(p.dataset.status);
  };

  $('#viewPills').onclick = (e) => {
    const p = e.target.closest('.pill');
    if (!p) return;
    state.filters.view = state.filters.view === p.dataset.view ? null : p.dataset.view;
    render();
  };

  $('#topicFilter').onchange = (e) => { state.filters.topic = e.target.value; renderTable(); };

  $('#btnClear').onclick = () => {
    state.filters = { q: '', diff: 'all', status: 'all', topic: '', view: null };
    $('#search').value = '';
    $('#topicFilter').value = '';
    document.querySelectorAll('.pill').forEach((p) => p.classList.remove('on'));
    document.querySelector('#diffPills .pill[data-diff="all"]').classList.add('on');
    document.querySelector('#statusPills .pill[data-status="all"]').classList.add('on');
    render();
  };

  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 'title' ? 1 : -1 };
      renderTable();
    };
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && document.activeElement.tagName !== 'INPUT') {
      e.preventDefault();
      $('#search').focus();
    }
  });

  refresh();
  setInterval(refresh, 20000);
}

init();
