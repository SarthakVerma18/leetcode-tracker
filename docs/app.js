/* Public read-only view. Reads the static data.json built by build_site.py. */

const state = {
  data: null,
  filters: { q: '', diff: 'all', status: 'all', topic: '', view: null },
  sort: { key: 'first_ac', dir: -1 },
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const STATUS_LABELS = { new: 'New', solid: 'Solid', revise: 'Revise', revisit: 'Revisit' };

function fmtDate(ts) {
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleDateString(undefined,
    { day: '2-digit', month: 'short', year: '2-digit' });
}

function ago(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ------------------------------------------------------------------ cards */

function renderCards(d) {
  const s = d.stats;
  const bd = s.by_difficulty;
  const host = $('#cards');
  host.innerHTML = '';

  const solved = el('div', 'card');
  solved.innerHTML = `<div class="label">Problems solved</div>
    <div class="value">${s.tracked}</div>`;
  const bars = el('div', 'bars');
  [[bd.Easy, 'var(--easy)'], [bd.Medium, 'var(--medium)'], [bd.Hard, 'var(--hard)']]
    .forEach(([n, c]) => {
      const b = el('div', 'bar');
      b.style.flex = String(Math.max(n, 0.01));
      b.style.background = c;
      bars.appendChild(b);
    });
  solved.appendChild(bars);
  solved.appendChild(el('div', 'foot',
    `${bd.Easy} easy · ${bd.Medium} medium · ${bd.Hard} hard`));
  host.appendChild(solved);

  const mk = (label, value, foot, color) => {
    const c = el('div', 'card');
    c.innerHTML = `<div class="label">${label}</div>
      <div class="value"${color ? ` style="color:${color}"` : ''}>${value}</div>
      <div class="foot">${foot}</div>`;
    return c;
  };

  const pct = d.profile.total
    ? Math.round((bd.Medium + bd.Hard) / Math.max(1, s.tracked) * 100) : 0;
  host.appendChild(mk('Medium + Hard', `${pct}%`, 'of everything solved'));

  const cal = d.calendar || {};
  host.appendChild(mk('Current streak', cal.streak || 0,
    `${cal.active_days || 0} active days this year`,
    cal.streak ? 'var(--accent)' : null));

  host.appendChild(mk('Topics covered', d.topics.length, 'distinct tags'));

  const solid = d.problems.filter((p) => p.status === 'solid').length;
  host.appendChild(mk('Marked solid', solid, 'confident without a refresher',
    solid ? 'var(--ok)' : null));
}

function renderTopics(d) {
  const counts = {};
  d.problems.forEach((p) => p.topics.forEach((t) => {
    counts[t] = (counts[t] || 0) + 1;
  }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 12);
  const grid = $('#topicGrid');
  grid.innerHTML = '';
  $('#topicTitle').textContent = `Top topics (${Object.keys(counts).length} total)`;
  top.forEach(([name, n]) => {
    const row = el('div', 'topic-row');
    row.appendChild(el('span', 'nm', name));
    row.appendChild(el('span', 'ct', String(n)));
    row.onclick = () => {
      state.filters.topic = state.filters.topic === name ? '' : name;
      $('#topicFilter').value = state.filters.topic;
      renderTable();
      document.querySelector('.table-wrap').scrollIntoView({ behavior: 'smooth' });
    };
    grid.appendChild(row);
  });
}

/* ------------------------------------------------------------------ table */

function visibleRows() {
  const f = state.filters;
  const q = f.q.trim().toLowerCase();
  const rows = state.data.problems.filter((r) => {
    if (f.diff !== 'all' && r.difficulty !== f.diff) return false;
    if (f.status !== 'all' && r.status !== f.status) return false;
    if (f.topic && !r.topics.includes(f.topic)) return false;
    if (q) {
      const hay = (r.title + ' ' + r.slug + ' ' + r.topics.join(' ') + ' ' + r.qid)
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const { key, dir } = state.sort;
  const diffOrder = { Easy: 1, Medium: 2, Hard: 3, Unknown: 4 };
  const statusOrder = { revisit: 1, revise: 2, new: 3, solid: 4 };
  rows.sort((a, b) => {
    let x = a[key], y = b[key];
    if (key === 'difficulty') { x = diffOrder[x] || 9; y = diffOrder[y] || 9; }
    if (key === 'status') { x = statusOrder[x] || 9; y = statusOrder[y] || 9; }
    if (key === 'title') return dir * String(x).localeCompare(String(y));
    x = x == null ? -Infinity : x;
    y = y == null ? -Infinity : y;
    return dir * (x - y);
  });
  return rows;
}

function renderTable() {
  const rows = visibleRows();
  const tbody = $('#rows');
  tbody.innerHTML = '';
  $('#emptyState').innerHTML = '';

  if (!rows.length) {
    const e = el('div', 'empty');
    e.innerHTML = '<h3>Nothing matches</h3><div>Try clearing the filters.</div>';
    $('#emptyState').appendChild(e);
  }

  const frag = document.createDocumentFragment();
  for (const r of rows) {
    const tr = el('tr');

    tr.appendChild(el('td', 'qid', r.qid || '—'));

    const tdTitle = el('td', 'title-cell');
    const a = el('a', null, r.title);
    a.href = r.url;
    a.target = '_blank';
    a.rel = 'noreferrer';
    tdTitle.appendChild(a);
    tdTitle.appendChild(el('span', 'ext', '↗'));
    tr.appendChild(tdTitle);

    tr.appendChild(el('td', 'diff ' + r.difficulty, r.difficulty));

    const tdTopics = el('td', 'hide-sm');
    const box = el('div', 'topics');
    r.topics.slice(0, 3).forEach((t) => {
      const tag = el('span', 'tag', t);
      tag.onclick = () => {
        state.filters.topic = t;
        $('#topicFilter').value = t;
        renderTable();
      };
      box.appendChild(tag);
    });
    if (r.topics.length > 3) {
      const more = el('span', 'tag', `+${r.topics.length - 3}`);
      more.title = r.topics.slice(3).join(', ');
      box.appendChild(more);
    }
    tdTopics.appendChild(box);
    tr.appendChild(tdTopics);

    const dtxt = fmtDate(r.first_ac);
    tr.appendChild(el('td', 'date' + (dtxt ? '' : ' none'), dtxt || '—'));

    tr.appendChild(el('td', 'date', STATUS_LABELS[r.status] || 'New'));

    const tdConf = el('td');
    const conf = el('div', 'conf ro');
    for (let i = 1; i <= 5; i++) conf.appendChild(el('i', i <= r.confidence ? 'on' : ''));
    tdConf.appendChild(conf);
    tr.appendChild(tdConf);

    frag.appendChild(tr);
  }
  tbody.appendChild(frag);

  $('#countLine').textContent =
    `Showing ${rows.length} of ${state.data.problems.length} solved problems`;

  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    const old = th.querySelector('.arrow');
    if (old) old.remove();
    if (th.dataset.sort === state.sort.key) {
      th.appendChild(el('span', 'arrow', state.sort.dir === 1 ? '▲' : '▼'));
    }
  });
}

/* -------------------------------------------------------------------- csv */

function downloadCsv() {
  const head = ['#', 'Title', 'URL', 'Difficulty', 'Topics', 'Solved On',
    'Status', 'Confidence'];
  const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [head.join(',')];
  visibleRows().forEach((r) => {
    lines.push([
      r.qid, r.title, r.url, r.difficulty, r.topics.join('; '),
      r.first_ac ? new Date(r.first_ac * 1000).toISOString().slice(0, 10) : '',
      r.status, r.confidence || '',
    ].map(esc).join(','));
  });
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'leetcode-solved.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ------------------------------------------------------------------- init */

async function init() {
  const res = await fetch('data.json?t=' + Date.now());
  state.data = await res.json();
  const d = state.data;

  const link = $('#profileLink');
  link.textContent = '@' + d.username;
  link.href = `https://leetcode.com/u/${d.username}/`;
  $('#rankLine').textContent = d.profile.ranking
    ? ` · rank #${d.profile.ranking.toLocaleString()}` : '';
  $('#updated').textContent = 'updated ' + ago(d.generated_at);

  const sel = $('#topicFilter');
  d.topics.forEach((t) => {
    const o = el('option', null, t);
    o.value = t;
    sel.appendChild(o);
  });

  renderCards(d);
  renderTopics(d);
  renderTable();

  $('#search').oninput = (e) => { state.filters.q = e.target.value; renderTable(); };
  sel.onchange = (e) => { state.filters.topic = e.target.value; renderTable(); };
  $('#btnCsv').onclick = downloadCsv;

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
    if (!p) return;
    state.filters.status = p.dataset.status;
    document.querySelectorAll('#statusPills .pill').forEach((x) => x.classList.remove('on'));
    p.classList.add('on');
    renderTable();
  };

  $('#btnClear').onclick = () => {
    state.filters = { q: '', diff: 'all', status: 'all', topic: '', view: null };
    $('#search').value = '';
    sel.value = '';
    document.querySelectorAll('.pill').forEach((p) => p.classList.remove('on'));
    document.querySelector('#diffPills .pill[data-diff="all"]').classList.add('on');
    document.querySelector('#statusPills .pill[data-status="all"]').classList.add('on');
    renderTable();
  };

  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir *= -1;
      else state.sort = { key, dir: key === 'title' ? 1 : -1 };
      renderTable();
    };
  });
}

init();
