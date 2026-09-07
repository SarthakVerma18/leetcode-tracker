/* Practice mode: shuffle N solved problems and drill through them.
   Relies on state / api / el / $ / modal / refresh from app.js. */

const practice = { session: null, idx: 0, timer: null, keys: null };

const POOL_LABELS = {
  all: 'Everything I have solved',
  due: 'Due for review',
  unrated: 'Unrated (never scored)',
  weak: 'Weak spots (low confidence)',
  revisit: 'Marked "revisit"',
  starred: 'Starred',
};

const OUTCOME_LABELS = {
  nailed: 'Nailed it', shaky: 'Shaky', failed: 'Failed', skipped: 'Skipped',
};

/* ------------------------------------------------------------------ setup */

function showPracticeSetup() {
  const d = state.data;
  const pools = d.practice_pools || {};

  const box = el('div');
  box.innerHTML = `
    <h2>Practice session</h2>
    <p>Pick how many problems you want. They get shuffled at random from the
    pool you choose, then served one at a time. How you rate each one feeds
    straight back into its confidence score and next review date.</p>`;

  const row1 = el('div', 'field-row');
  row1.innerHTML = `
    <div style="max-width:130px">
      <label>How many</label>
      <input type="number" id="pCount" min="1" max="50" value="5" />
    </div>
    <div>
      <label>Pool</label>
      <select id="pPool"></select>
    </div>`;
  box.appendChild(row1);

  const row2 = el('div', 'field-row');
  row2.innerHTML = `
    <div>
      <label>Difficulty</label>
      <select id="pDiff">
        <option value="">Any</option>
        <option>Easy</option><option>Medium</option><option>Hard</option>
      </select>
    </div>
    <div>
      <label>Topic</label>
      <select id="pTopic"><option value="">Any</option></select>
    </div>`;
  box.appendChild(row2);

  const warn = el('div', 'hint', '');
  box.appendChild(warn);

  const row = el('div', 'row');
  const cancel = el('button', null, 'Cancel');
  const go = el('button', 'primary', 'Start session');
  row.appendChild(cancel);
  row.appendChild(go);
  box.appendChild(row);

  const bg = modal(box);

  const poolSel = box.querySelector('#pPool');
  Object.entries(POOL_LABELS).forEach(([value, label]) => {
    const n = pools[value] || 0;
    const o = el('option', null, `${label} (${n})`);
    o.value = value;
    if (!n) o.disabled = true;
    poolSel.appendChild(o);
  });

  const topicSel = box.querySelector('#pTopic');
  d.topics.forEach((t) => {
    const o = el('option', null, t);
    o.value = t;
    topicSel.appendChild(o);
  });

  const countInput = box.querySelector('#pCount');
  const syncWarn = () => {
    const avail = pools[poolSel.value] || 0;
    const want = parseInt(countInput.value, 10) || 0;
    warn.textContent = want > avail
      ? `Only ${avail} problem(s) in that pool — the session will use all of them.`
      : '';
  };
  poolSel.onchange = syncWarn;
  countInput.oninput = syncWarn;

  cancel.onclick = () => bg.remove();
  go.onclick = async () => {
    go.disabled = true;
    go.textContent = 'Shuffling…';
    const res = await api('/api/practice/new', {
      count: parseInt(countInput.value, 10) || 5,
      pool: poolSel.value,
      difficulty: box.querySelector('#pDiff').value,
      topic: topicSel.value,
    });
    if (res.error) {
      go.disabled = false;
      go.textContent = 'Start session';
      warn.textContent = res.error;
      return;
    }
    bg.remove();
    openPractice(res.session);
  };
  countInput.focus();
  countInput.select();
}

/* --------------------------------------------------------------- session */

function openPractice(session) {
  practice.session = session;
  const firstOpen = session.problems.findIndex((p) => !p.outcome);
  practice.idx = firstOpen === -1 ? session.problems.length : firstOpen;
  renderPractice();

  practice.keys = (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
    const map = { 1: 'nailed', 2: 'shaky', 3: 'failed', 4: 'skipped' };
    if (map[e.key]) {
      e.preventDefault();
      answerPractice(map[e.key]);
    }
    if (e.key === 'Escape') closePractice(false);
  };
  document.addEventListener('keydown', practice.keys);
  clearInterval(practice.timer);
  practice.timer = setInterval(tickTimer, 1000);
}

function tickTimer() {
  const node = document.querySelector('#pTimer');
  if (!node || !practice.session) return;
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - practice.session.created_at);
  const m = String(Math.floor(secs / 60)).padStart(2, '0');
  const s = String(secs % 60).padStart(2, '0');
  node.textContent = `${m}:${s}`;
}

async function closePractice(finish) {
  if (finish) await api('/api/practice/finish', {});
  clearInterval(practice.timer);
  if (practice.keys) document.removeEventListener('keydown', practice.keys);
  practice.session = null;
  $('#practiceHost').innerHTML = '';
  refresh();
}

async function answerPractice(outcome) {
  const s = practice.session;
  if (!s) return;
  const p = s.problems[practice.idx];
  if (!p) return;
  const res = await api('/api/practice/answer', { slug: p.slug, outcome });
  if (res.session) practice.session = res.session;
  practice.idx += 1;
  renderPractice();
}

/* ---------------------------------------------------------------- render */

function renderPractice() {
  const host = $('#practiceHost');
  const s = practice.session;
  host.innerHTML = '';
  if (!s) return;

  const shell = el('div', 'practice-shell');
  const inner = el('div', 'practice-inner');
  shell.appendChild(inner);

  const done = practice.idx >= s.problems.length;

  const head = el('div', 'practice-head');
  const titleBox = el('div');
  titleBox.appendChild(el('h2', null, done ? 'Session complete' : 'Practice session'));
  titleBox.appendChild(el('div', 'meta',
    `${POOL_LABELS[s.pool] || s.pool} · ${s.problems.length} problems`));
  head.appendChild(titleBox);
  head.appendChild(el('div', 'spacer'));

  const timer = el('div', 'timer');
  timer.id = 'pTimer';
  timer.textContent = '00:00';
  head.appendChild(timer);

  const quit = el('button', null, done ? 'Close' : 'End session');
  quit.onclick = () => closePractice(true);
  head.appendChild(quit);
  inner.appendChild(head);

  const strip = el('div', 'strip');
  s.problems.forEach((p, i) => {
    const seg = el('i', p.outcome || (i === practice.idx && !done ? 'cur' : ''));
    seg.title = `${i + 1}. ${p.title}` +
      (p.outcome ? ` — ${OUTCOME_LABELS[p.outcome]}` : '');
    strip.appendChild(seg);
  });
  inner.appendChild(strip);

  if (done) {
    inner.appendChild(renderSummary(s));
    host.appendChild(shell);
    tickTimer();
    return;
  }

  const p = s.problems[practice.idx];
  const card = el('div', 'pcard');
  card.appendChild(el('div', 'num',
    `Problem ${practice.idx + 1} of ${s.problems.length}`));

  const title = el('h3');
  const link = el('a', null, `${p.qid ? p.qid + '. ' : ''}${p.title}`);
  link.href = p.url;
  link.target = '_blank';
  link.rel = 'noreferrer';
  title.appendChild(link);
  card.appendChild(title);

  const row2 = el('div', 'row2');
  row2.appendChild(el('span', 'diff ' + p.difficulty, p.difficulty));
  const tbox = el('div', 'topics');
  p.topics.forEach((t) => tbox.appendChild(el('span', 'tag', t)));
  row2.appendChild(tbox);
  card.appendChild(row2);

  const open = el('a', 'open', 'Open on LeetCode ↗');
  open.href = p.url;
  open.target = '_blank';
  open.rel = 'noreferrer';
  card.appendChild(open);

  card.appendChild(el('label', null, 'Your notes'));
  const ta = el('textarea');
  ta.value = p.note || '';
  ta.placeholder = 'What was the trick? Where did you get stuck?';
  let noteTimer = null;
  const saveNote = () => api('/api/note', { slug: p.slug, note: ta.value });
  ta.oninput = () => { clearTimeout(noteTimer); noteTimer = setTimeout(saveNote, 700); };
  ta.onblur = () => { clearTimeout(noteTimer); saveNote(); };
  card.appendChild(ta);

  const meta = [];
  if (p.confidence) meta.push(`current confidence ${p.confidence}/5`);
  if (p.last_revised) meta.push(`last revised ${p.last_revised}`);
  if (p.first_ac) meta.push(`solved ${new Date(p.first_ac * 1000).toLocaleDateString()}`);
  card.appendChild(el('div', 'hint', meta.join(' · ') || 'No history on this one yet.'));
  inner.appendChild(card);

  const ans = el('div', 'answers');
  [['nailed', 'Nailed it', '1'], ['shaky', 'Shaky', '2'],
   ['failed', 'Failed', '3'], ['skipped', 'Skip', '4']].forEach(([key, label, hint]) => {
    const b = el('button', key);
    b.appendChild(document.createTextNode(label));
    b.appendChild(el('span', 'k', `press ${hint}`));
    b.onclick = () => answerPractice(key);
    ans.appendChild(b);
  });
  inner.appendChild(ans);

  host.appendChild(shell);
  tickTimer();
}

function renderSummary(s) {
  const box = el('div', 'summary');
  const counts = { nailed: 0, shaky: 0, failed: 0, skipped: 0 };
  s.problems.forEach((p) => { if (p.outcome) counts[p.outcome]++; });

  const secs = Math.max(0, Math.floor(Date.now() / 1000) - s.created_at);
  box.appendChild(el('h2', null, 'Nice work'));
  box.appendChild(el('p', null,
    `${s.problems.length} problems in ${Math.floor(secs / 60)}m ${secs % 60}s. ` +
    'Confidence scores and review dates have been updated.'));

  const tally = el('div', 'tally');
  [['nailed', 'var(--ok)'], ['shaky', 'var(--medium)'],
   ['failed', 'var(--hard)'], ['skipped', 'var(--faint)']].forEach(([key, color]) => {
    const cell = el('div');
    const n = el('b', null, String(counts[key]));
    n.style.color = color;
    cell.appendChild(n);
    cell.appendChild(el('span', null, OUTCOME_LABELS[key]));
    tally.appendChild(cell);
  });
  box.appendChild(tally);

  const weak = s.problems.filter(
    (p) => p.outcome === 'failed' || p.outcome === 'shaky');
  if (weak.length) {
    box.appendChild(el('div', 'hint', 'Scheduled to come back soon:'));
    const ul = el('ul');
    weak.forEach((p) => {
      const li = el('li');
      const a = el('a', null, p.title);
      a.href = p.url;
      a.target = '_blank';
      a.rel = 'noreferrer';
      li.appendChild(a);
      li.appendChild(document.createTextNode(
        ` — ${OUTCOME_LABELS[p.outcome].toLowerCase()}`));
      ul.appendChild(li);
    });
    box.appendChild(ul);
  }

  const again = el('button', 'primary', 'Another session');
  again.onclick = async () => { await closePractice(true); showPracticeSetup(); };
  box.appendChild(again);
  return box;
}

/* ------------------------------------------------------------------ wire */

$('#btnPractice').onclick = async () => {
  const res = await api('/api/practice');
  if (res.session && res.session.answered < res.session.problems.length) {
    openPractice(res.session);  // resume a session left half-finished
  } else {
    showPracticeSetup();
  }
};
