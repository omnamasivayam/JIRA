/* SprintPilot front-end – plain JS, no build step. */
'use strict';

// ---------------------------------------------------------------- utils
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ls = {
  get(k, d) { try { const v = localStorage.getItem('sp.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('sp.' + k, JSON.stringify(v)); } catch { /* ignore */ } },
};
const plural = (n, one = 'story', many = 'stories') => `${n} ${n === 1 ? one : many}`;
const sum = (arr, f) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);
const hash = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h); };
const initials = (n) => String(n || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const EPIC_COLORS = ['#5b5bd6', '#e5484d', '#12a594', '#f76b15', '#8e4ec6', '#0090ff', '#d6409f', '#46a758', '#ab6400', '#3e63dd', '#e54666', '#0d74ce'];

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `${r.status} ${r.statusText}`);
  if (j.warnings && j.warnings.length) toast('Saved, with notes:\n• ' + j.warnings.join('\n• '), 'warn', 9000);
  if (j.warning) toast(j.warning, 'warn');
  return j;
}

function toast(msg, kind = '', ms = 3800) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- state
const S = {
  data: null,
  view: ls.get('view', 'plan'),
  search: '',
  planSprint: ls.get('planSprint', 'open'),
  sprintEpic: 'all',
  teamSprint: null,
  sizingSprint: ls.get('sizingSprint', 'open'),
  sizingOnlyUnsized: true,
  sizingKey: null,
  sizedThisSession: 0,
  drafts: [],
  draftEngine: '',
  composeText: ls.get('composeText', ''),
  composeDefaults: ls.get('composeDefaults', { epic: 'auto', sprint: '', assignee: '' }),
  created: [],
  capacity: ls.get('capacity', {}),
  selected: new Set(),
  drawerKey: null,
  drawerDirty: {},
};

const D = () => S.data;
const epicMap = () => Object.fromEntries(D().epics.map((e, i) => [e.key, { ...e, color: EPIC_COLORS[i % EPIC_COLORS.length] }]));
const sprintById = (id) => D().sprints.find((s) => String(s.id) === String(id));
const userById = (id) => D().users.find((u) => String(u.id) === String(id));
const activeSprint = () => D().sprints.find((s) => s.state === 'active');
const futureSprints = () => D().sprints.filter((s) => s.state === 'future');
const issueByKey = (k) => D().issues.find((i) => i.key === k);
const isSpilled = (i) => (i.labels || []).includes(D().spilloverLabel) || (i.sprintHistory || []).length > 1;

function filtered() {
  const q = S.search.trim().toLowerCase();
  if (!q) return D().issues;
  return D().issues.filter((i) => `${i.key} ${i.summary} ${i.assignee ? i.assignee.name : ''} ${(i.labels || []).join(' ')} ${i.status}`.toLowerCase().includes(q));
}

function sprintFilter(v) {
  if (v === 'all') return () => true;
  if (v === 'backlog') return (i) => !i.sprintId;
  if (v === 'open') return (i) => i.statusCategory !== 'done' || (i.sprintId && sprintById(i.sprintId));
  return (i) => String(i.sprintId) === String(v);
}

function upsert(issue) {
  const idx = D().issues.findIndex((i) => i.key === issue.key);
  if (idx >= 0) D().issues[idx] = issue; else D().issues.unshift(issue);
}

// ---------------------------------------------------------------- small HTML helpers
const opt = (v, label, sel) => `<option value="${esc(v)}" ${String(v) === String(sel ?? '') ? 'selected' : ''}>${esc(label)}</option>`;
const epicOptions = (sel, auto) => (auto ? opt('auto', '✨ Auto-suggest epic', sel) : '') + opt('', '— No epic —', sel) + D().epics.map((e) => opt(e.key, `${e.key} · ${e.summary}`, sel)).join('');
const sprintOptions = (sel) => opt('', 'Backlog (no sprint)', sel) + D().sprints.map((s) => opt(s.id, `${s.name}${s.state === 'active' ? '  ● active' : ''}`, sel)).join('');
const userOptions = (sel) => opt('', 'Unassigned', sel) + D().users.map((u) => opt(u.id, u.name, sel)).join('');
function sprintFilterOptions(sel, { all = true, open = true } = {}) {
  return (open ? opt('open', 'Open sprints + backlog', sel) : '') + (all ? opt('all', 'Everything', sel) : '') + opt('backlog', 'Backlog only', sel)
    + D().sprints.map((s) => opt(s.id, `${s.name}${s.state === 'active' ? ' ● active' : ''}`, sel)).join('');
}

function avatar(u, cls = '') {
  if (!u) return `<span class="avatar none ${cls}" title="Unassigned">?</span>`;
  return `<span class="avatar ${cls}" style="background:hsl(${hash(u.name) % 360} 55% 52%)" title="${esc(u.name)}">${esc(initials(u.name))}</span>`;
}
const pts = (p) => (p === null || p === undefined ? '<span class="pts none" title="Not sized">–</span>' : `<span class="pts" title="Story points">${p}</span>`);
const statusPill = (i) => `<span class="status ${i.statusCategory}">${esc(i.status || '—')}</span>`;
function epicChip(key) {
  if (!key) return '';
  const e = epicMap()[key];
  const color = e ? e.color : '#999';
  return `<span class="chip" title="${esc(e ? e.summary : key)}"><span class="dot" style="background:${color}"></span><span class="tx">${esc(e ? e.summary : key)}</span></span>`;
}
const testableMark = (t) => (t === true ? '<span class="tst yes" title="Testable">✓ T</span>' : t === false ? '<span class="tst no" title="Not testable">✕ T</span>' : '');
const seg = (values, cur, attrs, extra = (v) => '') => `<div class="seg">${values.map((v) => `<button type="button" class="${String(v.value) === String(cur) ? 'on' : ''} ${extra(v)}" ${attrs(v)}>${esc(v.label)}</button>`).join('')}</div>`;

function card(i, o = {}) {
  return `<div class="card ${i.statusCategory} ${S.selected.has(i.key) ? 'selected' : ''}" draggable="true" data-key="${esc(i.key)}">
    <div class="card-row"><span class="key">${esc(i.key)}</span>${isSpilled(i) ? '<span class="badge spill" title="Spilled over from an earlier sprint">↻ spill</span>' : ''}<span class="spacer"></span>${pts(i.points)}</div>
    <div class="card-title">${esc(i.summary)}</div>
    <div class="card-row meta">${o.hideEpic ? '' : epicChip(i.epicKey)}${o.hideStatus ? '' : statusPill(i)}${testableMark(i.testable)}${o.sprint && i.sprintName ? `<span class="chip"><span class="tx">${esc(i.sprintName)}</span></span>` : ''}<span class="spacer"></span>${o.hideAvatar ? '' : avatar(i.assignee)}</div>
  </div>`;
}

function progressBar(list, capacity) {
  const total = sum(list, (i) => i.points);
  const done = sum(list.filter((i) => i.statusCategory === 'done'), (i) => i.points);
  const prog = sum(list.filter((i) => i.statusCategory === 'inprogress'), (i) => i.points);
  const base = Math.max(total, capacity || 0, 1);
  const over = capacity && total > capacity;
  return `<div class="progress" title="${done} done · ${prog} in progress · ${total} total${capacity ? ` · capacity ${capacity}` : ''}">
    <i class="p-done" style="width:${(done / base) * 100}%"></i><i class="p-prog" style="width:${(prog / base) * 100}%"></i>${over ? `<i class="p-over" style="width:${((total - capacity) / base) * 100}%;margin-left:auto"></i>` : ''}</div>`;
}

// ---------------------------------------------------------------- views
const VIEWS = {
  plan: { title: 'Epic planner', render: viewPlan },
  sprints: { title: 'Sprint planner', render: viewSprints },
  compose: { title: 'Quick create', render: viewCompose },
  sizing: { title: 'Story sizing', render: viewSizing },
  team: { title: "Who's working on what", render: viewTeam },
};

function render() {
  if (!S.data) return;
  if (!VIEWS[S.view]) S.view = 'plan';
  $$('#nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === S.view));
  $('#viewTitle').textContent = VIEWS[S.view].title;
  const scroll = $('.columns') ? $('.columns').scrollLeft : 0;
  $('#view').innerHTML = VIEWS[S.view].render();
  if ($('.columns')) $('.columns').scrollLeft = scroll;
  if (S.drawerKey) renderDrawer();
}

function setView(v) {
  S.view = v; ls.set('view', v);
  history.replaceState(null, '', '#' + v);
  S.selected.clear();
  render();
  if (v === 'compose') setTimeout(() => $('#composeText') && $('#composeText').focus(), 0);
}

// ---- Epic planner
function viewPlan() {
  const em = epicMap();
  const list = filtered().filter(sprintFilter(S.planSprint));
  const unknown = [...new Set(list.map((i) => i.epicKey).filter((k) => k && !em[k]))];
  const cols = [{ key: '', summary: 'No epic yet', none: true }, ...D().epics.map((e) => em[e.key]), ...unknown.map((k) => ({ key: k, summary: `${k} (closed epic)`, color: '#999' }))];
  const sprintForNew = /^\d+$/.test(String(S.planSprint)) ? S.planSprint : '';
  return `<div class="toolbar">
      <label>Show <select data-change="planSprint">${sprintFilterOptions(S.planSprint)}</select></label>
      <span class="hint">Drag stories onto an epic to link them · Ctrl/⌘-click to select several · Click a card to edit</span>
    </div>
    <div class="columns">
      ${cols.map((c) => {
        const items = list.filter((i) => (i.epicKey || '') === c.key);
        const total = sum(items, (i) => i.points);
        const unsized = items.filter((i) => i.points == null).length;
        return `<div class="column drop" data-drop="epic" data-value="${esc(c.key)}">
          <div class="col-head">
            <div class="col-title">${c.none ? '<span class="dot" style="background:var(--text-3)"></span>' : `<span class="dot" style="background:${c.color}"></span>`}<span class="t" title="${esc(c.summary)}">${esc(c.summary)}</span><span class="key">${esc(c.key)}</span></div>
            <div class="col-sub"><span>${plural(items.length)}</span><span>${total} pts</span>${unsized ? `<span title="Not sized yet">${unsized} unsized</span>` : ''}</div>
            ${c.none ? '' : `<div style="margin-top:8px">${progressBar(items)}</div>`}
          </div>
          <div class="col-body">${items.map((i) => card(i, { hideEpic: true, sprint: S.planSprint === 'all' || S.planSprint === 'open' })).join('') || '<div class="hint" style="text-align:center;padding:14px 4px">Drop stories here</div>'}</div>
          <div class="col-foot"><input class="quick-add" type="text" placeholder="＋ Describe a story, press Enter" data-quickadd-epic="${esc(c.key)}" data-quickadd-sprint="${esc(sprintForNew)}" /></div>
        </div>`;
      }).join('')}
      <div class="column ghost">
        <div class="col-title">＋ New epic</div>
        <input type="text" id="newEpicName" placeholder="Epic name" />
        <button class="btn small primary" data-action="createEpic">Create epic</button>
      </div>
    </div>`;
}

// ---- Sprint planner
function viewSprints() {
  const list = filtered().filter((i) => S.sprintEpic === 'all' || (i.epicKey || '') === S.sprintEpic);
  const cols = [{ id: '', name: 'Backlog', state: 'backlog' }, ...D().sprints];
  return `<div class="toolbar">
      <label>Epic <select data-change="sprintEpic">${opt('all', 'All epics', S.sprintEpic)}${epicOptions(S.sprintEpic)}</select></label>
      <span class="hint">Drag stories between backlog and sprints · Set team capacity per sprint · Spill over unfinished work in one click</span>
    </div>
    <div class="columns">
      ${cols.map((s) => {
        const items = list.filter((i) => String(i.sprintId || '') === String(s.id) && (s.id || i.statusCategory !== 'done'));
        const cap = S.capacity[s.id] || 0;
        const total = sum(items, (i) => i.points);
        const remaining = items.filter((i) => i.statusCategory !== 'done');
        return `<div class="column drop" data-drop="sprint" data-value="${esc(s.id)}">
          <div class="col-head">
            <div class="col-title"><span class="t">${esc(s.name)}</span>${s.state === 'active' ? '<span class="badge active">active</span>' : s.state === 'future' ? '<span class="badge future">next</span>' : ''}</div>
            <div class="col-sub"><span>${plural(items.length)}</span><span style="${cap && total > cap ? 'color:var(--bad);font-weight:700' : ''}">${total}${cap ? ` / ${cap}` : ''} pts</span>
              ${s.id ? `<span>cap <input class="cap-input" type="number" min="0" value="${cap || ''}" placeholder="—" data-capacity="${s.id}" title="Team capacity in points"></span>` : ''}</div>
            ${s.endDate ? `<div class="col-sub">${fmtDate(s.startDate)} → ${fmtDate(s.endDate)}${s.state === 'active' ? ` · ${daysLeft(s.endDate)}` : ''}</div>` : ''}
            ${s.goal ? `<div class="col-sub" title="Sprint goal">🎯 ${esc(s.goal)}</div>` : ''}
            ${s.id ? `<div style="margin-top:8px">${progressBar(items, cap)}</div>` : ''}
            ${s.state === 'active' && remaining.length ? `<button class="btn small" style="margin-top:10px;width:100%" data-action="spillover" data-sprint="${s.id}">↻ Spill over ${remaining.length} unfinished…</button>` : ''}
          </div>
          <div class="col-body">${items.map((i) => card(i)).join('') || '<div class="hint" style="text-align:center;padding:14px 4px">Drop stories here</div>'}</div>
        </div>`;
      }).join('')}
    </div>`;
}
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '');
function daysLeft(end) {
  const d = Math.ceil((new Date(end) - Date.now()) / 864e5);
  return d < 0 ? 'ended' : d === 0 ? 'last day' : `${d} days left`;
}

// ---- Quick create
function viewCompose() {
  const d = S.composeDefaults;
  return `<div class="compose">
    <div class="panel sticky">
      <div class="section-lbl">Describe the work</div>
      <textarea id="composeText" class="big" placeholder="Write naturally — one story per paragraph or bullet. For example:

- Customers should be able to download their invoices as PDF from the billing page
- As an admin I want to see who changed user permissions so that we can audit access
- Spike: evaluate two payment providers for recurring billing

Tip: you can also paste rows straight from Excel (with a header row like Summary | Description | Points | Epic).">${esc(S.composeText)}</textarea>
      <div class="defaults">
        <span>Epic</span><select data-compose-default="epic">${epicOptions(d.epic, true)}</select>
        <span>Sprint</span><select data-compose-default="sprint">${sprintOptions(d.sprint)}</select>
        <span>Assignee</span><select data-compose-default="assignee">${userOptions(d.assignee)}</select>
      </div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btn primary" data-action="draft" id="draftBtn">✨ Draft stories</button>
        <span class="hint"><kbd>Ctrl</kbd>+<kbd>Enter</kbd></span>
        <span class="spacer"></span>
        <span class="hint">${esc(D().ai.status)}</span>
      </div>
    </div>
    <div>
      ${S.created.length ? `<div class="panel" style="margin-bottom:14px"><div class="section-lbl">Just created</div><div class="result-list">${S.created.map((r) => r.ok
        ? `<div>✅ <a href="${esc(r.issue.url)}" target="_blank" rel="noopener">${esc(r.issue.key)}</a> ${esc(r.issue.summary)}</div>`
        : `<div>❌ ${esc(r.summary)} — ${esc(r.error)}</div>`).join('')}</div></div>` : ''}
      ${S.drafts.length ? `<div class="drafts">${S.drafts.map(draftCard).join('')}</div>
        <div class="drafts-bar"><button class="btn primary" data-action="createDrafts">Create ${S.drafts.length} ${S.drafts.length === 1 ? 'story' : 'stories'} in Jira</button>
        <button class="btn" data-action="clearDrafts">Discard</button><span class="hint">${esc(S.draftEngine)} · Total ${sum(S.drafts, (x) => x.points)} pts</span></div>`
        : `<div class="empty">Your drafted stories appear here — review, tweak, and create them all in one click.<br><br>No more Excel → Jira copy-paste.</div>`}
    </div>
  </div>`;
}

function draftCard(s, idx) {
  const scale = D().pointScale.map((p) => ({ value: p, label: p }));
  return `<div class="draft" data-draft="${idx}">
    <div class="draft-head"><span class="num">#${idx + 1}</span><input type="text" value="${esc(s.summary)}" data-dfield="summary" placeholder="Story title" /><button class="x-btn" title="Remove" data-action="removeDraft" data-idx="${idx}">×</button></div>
    <div class="draft-row">
      <span class="mini-lbl">Points</span>${seg(scale, s.points, (v) => `data-action="draftPoints" data-idx="${idx}" data-v="${v.value}"`)}
      <span class="mini-lbl" style="margin-left:8px">Testable</span>${seg([{ value: true, label: 'Yes' }, { value: false, label: 'No' }], s.testable, (v) => `data-action="draftTestable" data-idx="${idx}" data-v="${v.value}"`, (v) => (v.value ? 'yes' : 'no'))}
    </div>
    <div class="draft-row">
      <select data-dfield="epicKey" title="Epic">${epicOptions(s.epicKey)}</select>${s.suggestedEpic && s.suggestedEpic === s.epicKey ? '<span class="badge ai">suggested</span>' : ''}
      <select data-dfield="sprintId" title="Sprint">${sprintOptions(s.sprintId)}</select>
      <select data-dfield="assigneeId" title="Assignee">${userOptions(s.assigneeId)}</select>
    </div>
    <details ${idx === 0 ? 'open' : ''}><summary>Description & acceptance criteria (${(s.acceptanceCriteria || []).length})</summary>
      <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">
        <textarea rows="4" data-dfield="description">${esc(s.description)}</textarea>
        <div class="mini-lbl">Acceptance criteria — one per line</div>
        <textarea rows="4" data-dfield="acceptanceCriteria">${esc((s.acceptanceCriteria || []).join('\n'))}</textarea>
      </div>
    </details>
  </div>`;
}

// ---- Sizing
function sizingQueue() {
  return filtered().filter(sprintFilter(S.sizingSprint)).filter((i) => i.statusCategory !== 'done');
}
function viewSizing() {
  const all = sizingQueue();
  const queue = S.sizingOnlyUnsized ? all.filter((i) => i.points == null || i.key === S.sizingKey) : all;
  if (!queue.some((i) => i.key === S.sizingKey)) S.sizingKey = queue[0] ? queue[0].key : null;
  const cur = issueByKey(S.sizingKey);
  const unsized = all.filter((i) => i.points == null).length;
  const scale = D().pointScale;
  return `<div class="toolbar">
      <label>Stories from <select data-change="sizingSprint">${sprintFilterOptions(S.sizingSprint)}</select></label>
      <label><input type="checkbox" data-change="sizingOnlyUnsized" ${S.sizingOnlyUnsized ? 'checked' : ''}/> Only unsized</label>
      <span class="hint">${unsized} unsized · ${S.sizedThisSession} sized this session · keys <kbd>1</kbd>–<kbd>${Math.min(scale.length, 9)}</kbd> to size, <kbd>←</kbd><kbd>→</kbd> to move, <kbd>0</kbd> clears</span>
    </div>
    <div class="sizing">
      <div>${cur ? `<div class="focus-card">
          <div class="card-row"><span class="key">${esc(cur.key)}</span>${epicChip(cur.epicKey)}${statusPill(cur)}${testableMark(cur.testable)}<span class="spacer"></span>${avatar(cur.assignee)}</div>
          <h2>${esc(cur.summary)}</h2>
          ${cur.description ? `<div class="desc">${esc(cur.description)}</div>` : '<div class="hint">No description</div>'}
          ${cur.acceptanceCriteria.length ? `<div class="section-lbl" style="margin-top:14px">Acceptance criteria</div><ul>${cur.acceptanceCriteria.map((a) => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}
          <div class="poker">${scale.map((p, n) => `<button class="${cur.points === p ? 'on' : ''}" data-action="size" data-v="${p}"><b>${p}</b>${n < 9 ? `<kbd>${n + 1}</kbd>` : ''}</button>`).join('')}</div>
          <div class="nav-row"><button class="btn small" data-action="sizeNav" data-dir="-1">← Prev</button><button class="btn small" data-action="sizeNav" data-dir="1">Skip →</button><span class="spacer"></span><button class="link-btn" data-action="open" data-key="${esc(cur.key)}">Open details</button></div>
        </div>` : '<div class="empty">🎉 Everything here is sized. Pick another sprint or untick “Only unsized”.</div>'}</div>
      <div class="panel"><div class="section-lbl">Queue (${queue.length})</div><div class="queue">
        ${queue.map((i) => `<div class="queue-item ${i.key === S.sizingKey ? 'cur' : ''}" data-action="sizePick" data-key="${esc(i.key)}"><span class="key">${esc(i.key)}</span><span class="t">${esc(i.summary)}</span>${pts(i.points)}</div>`).join('') || '<div class="hint">Nothing to size</div>'}
      </div></div>
    </div>`;
}

// ---- Team view
function viewTeam() {
  if (S.teamSprint === null) S.teamSprint = activeSprint() ? String(activeSprint().id) : 'open';
  const list = filtered().filter(sprintFilter(S.teamSprint));
  const people = new Map();
  for (const i of list) {
    const id = i.assignee ? i.assignee.id : '';
    if (!people.has(id)) people.set(id, { user: i.assignee, items: [] });
    people.get(id).items.push(i);
  }
  const rows = [...people.values()].sort((a, b) => (!a.user ? -1 : !b.user ? 1 : sum(b.items, (i) => i.points) - sum(a.items, (i) => i.points)));
  const idle = D().users.filter((u) => !people.has(u.id));
  const sp = sprintById(S.teamSprint);
  const total = sum(list, (i) => i.points);
  const done = sum(list.filter((i) => i.statusCategory === 'done'), (i) => i.points);
  const cats = [['todo', 'To do'], ['inprogress', 'In progress'], ['done', 'Done']];
  return `<div class="toolbar">
      <label>Sprint <select data-change="teamSprint">${sprintFilterOptions(S.teamSprint)}</select></label>
      <span class="hint">Drag a card to another person to reassign, or across columns to change status</span>
      <span class="spacer"></span>
      <button class="btn small" data-action="copyStandup">📋 Copy stand-up summary</button>
    </div>
    <div class="stats">
      <div class="stat"><div class="v">${list.length}</div><div class="l">Stories</div></div>
      <div class="stat"><div class="v">${done}<span style="font-size:14px;color:var(--text-3)"> / ${total} pts</span></div><div class="l">Points done (${total ? Math.round((done / total) * 100) : 0}%)</div></div>
      <div class="stat"><div class="v">${list.filter((i) => i.statusCategory === 'inprogress').length}</div><div class="l">In progress</div></div>
      <div class="stat"><div class="v" style="${people.has('') ? 'color:var(--warn)' : ''}">${people.has('') ? people.get('').items.length : 0}</div><div class="l">Unassigned</div></div>
      <div class="stat"><div class="v">${list.filter((i) => i.points == null).length}</div><div class="l">Unsized</div></div>
      ${sp && sp.endDate ? `<div class="stat"><div class="v">${daysLeft(sp.endDate)}</div><div class="l">${esc(sp.name)}</div></div>` : ''}
    </div>
    <div class="lanes">
      <div class="lane-h">Person</div>${cats.map(([, l]) => `<div class="lane-h">${l}</div>`).join('')}
      ${rows.map((r) => {
        const uid = r.user ? r.user.id : '';
        const p = sum(r.items, (i) => i.points);
        return `<div class="lane-person"><div class="who">${avatar(r.user, 'lg')}<div><div>${esc(r.user ? r.user.name : 'Unassigned')}</div><div class="sub">${plural(r.items.length)} · ${p} pts</div></div></div>${progressBar(r.items)}</div>
          ${cats.map(([c]) => `<div class="lane-cell drop" data-drop="lane" data-value="${esc(uid)}|${c}">${r.items.filter((i) => i.statusCategory === c).map((i) => card(i, { hideAvatar: true, hideStatus: c !== 'inprogress' })).join('')}</div>`).join('')}`;
      }).join('') || '<div class="empty" style="grid-column:1/-1">No stories in this selection</div>'}
    </div>
    ${idle.length ? `<div class="idle"><span class="hint">Nothing assigned (drop a card to assign):</span>${idle.map((u) => `<div class="drop" data-drop="lane" data-value="${esc(u.id)}|keep">${avatar(u)}${esc(u.name)}</div>`).join('')}</div>` : ''}`;
}

// ---------------------------------------------------------------- drawer (story details)
function openDrawer(key) {
  S.drawerKey = key;
  S.drawerDirty = {};
  S.transitions = null;
  renderDrawer();
  $('#drawer').classList.add('open');
  $('#drawerBackdrop').classList.add('show');
  api('GET', `/api/issues/${encodeURIComponent(key)}/transitions`).then((r) => { if (S.drawerKey === key) { S.transitions = r.transitions; renderDrawerStatus(); } }).catch(() => {});
}
function closeDrawer() {
  if (Object.keys(S.drawerDirty).length && !confirm('Discard unsaved text changes?')) return;
  S.drawerKey = null;
  $('#drawer').classList.remove('open');
  $('#drawerBackdrop').classList.remove('show');
}
function renderDrawerStatus() {
  const i = issueByKey(S.drawerKey);
  const el = $('#drawerStatus');
  if (!el || !i) return;
  el.innerHTML = `<select data-transition>${opt('', `${i.status} (current)`, '')}${(S.transitions || []).map((t) => opt(t.id, `→ ${t.name}${t.to && t.to !== t.name ? ` (${t.to})` : ''}`, '')).join('')}</select>`;
}
function renderDrawer() {
  const i = issueByKey(S.drawerKey);
  if (!i) return;
  const scale = D().pointScale.map((p) => ({ value: p, label: p }));
  const dirty = S.drawerDirty;
  const val = (k, d) => (k in dirty ? dirty[k] : d);
  $('#drawer').innerHTML = `
    <div class="drawer-head">
      <div class="card-row"><span class="key">${esc(i.key)}</span><span class="chip"><span class="tx">${esc(i.issueType)}</span></span>${isSpilled(i) ? '<span class="badge spill">↻ spilled over</span>' : ''}<span class="spacer"></span><button class="x-btn" data-action="closeDrawer">×</button></div>
      <input class="title-input" data-dd="summary" value="${esc(val('summary', i.summary))}" />
    </div>
    <div class="drawer-body">
      <div class="field-grid">
        <span class="lbl">Status</span><div id="drawerStatus"><span class="hint">${esc(i.status)} · loading transitions…</span></div>
        <span class="lbl">Story points</span>${seg([...scale, { value: '', label: '–' }], i.points ?? '', (v) => `data-action="dPoints" data-v="${v.value}"`)}
        <span class="lbl">Testable</span>${seg([{ value: true, label: 'Yes' }, { value: false, label: 'No' }], i.testable, (v) => `data-action="dTestable" data-v="${v.value}"`, (v) => (v.value ? 'yes' : 'no'))}
        <span class="lbl">Epic</span><select data-dsel="epicKey">${epicOptions(i.epicKey)}</select>
        <span class="lbl">Sprint</span><select data-dsel="sprintId">${sprintOptions(i.sprintId || '')}</select>
        <span class="lbl">Assignee</span><select data-dsel="assigneeId">${userOptions(i.assignee ? i.assignee.id : '')}</select>
        ${i.labels.length ? `<span class="lbl">Labels</span><div style="display:flex;gap:4px;flex-wrap:wrap">${i.labels.map((l) => `<span class="chip">${esc(l)}</span>`).join('')}</div>` : ''}
      </div>
      <div><div class="section-lbl">Description</div><textarea rows="7" data-dd="description">${esc(val('description', i.description))}</textarea></div>
      <div><div class="section-lbl">Acceptance criteria <span class="hint" style="text-transform:none;letter-spacing:0;font-weight:500">one per line</span></div>
        <textarea rows="5" data-dd="acceptanceCriteria">${esc(val('acceptanceCriteria', i.acceptanceCriteria.join('\n')))}</textarea></div>
    </div>
    <div class="drawer-foot">
      <button class="btn primary" data-action="saveDrawer" ${Object.keys(dirty).length ? '' : 'disabled'}>Save text changes</button>
      <button class="btn" data-action="clone" data-key="${esc(i.key)}">⧉ Clone & rewrite</button>
      <span class="spacer"></span>
      ${D().mode === 'jira' ? `<a class="btn small" href="${esc(i.url)}" target="_blank" rel="noopener">Open in Jira ↗</a>` : ''}
    </div>`;
  if (S.transitions) renderDrawerStatus();
}

// ---------------------------------------------------------------- data changes
function applyLocal(i, changes) {
  if ('assigneeId' in changes) i.assignee = changes.assigneeId ? userById(changes.assigneeId) || { id: changes.assigneeId, name: changes.assigneeId } : null;
  if ('sprintId' in changes) { const s = sprintById(changes.sprintId); i.sprintId = s ? s.id : null; i.sprintName = s ? s.name : ''; }
  for (const k of ['epicKey', 'points', 'testable', 'summary', 'description', 'acceptanceCriteria']) if (k in changes) i[k] = changes[k];
}

async function updateIssue(key, changes, { quiet } = {}) {
  const i = issueByKey(key);
  const prev = JSON.parse(JSON.stringify(i));
  applyLocal(i, changes);
  render();
  try {
    const r = await api('PATCH', `/api/issues/${encodeURIComponent(key)}`, changes);
    upsert(r.issue);
    if (!quiet) toast(`${key} updated`, 'ok', 1600);
  } catch (e) {
    upsert(prev);
    toast(`${key}: ${e.message}`, 'err', 8000);
  }
  render();
}

async function moveToSprint(keys, sprintId) {
  const prev = keys.map((k) => JSON.parse(JSON.stringify(issueByKey(k))));
  keys.forEach((k) => applyLocal(issueByKey(k), { sprintId }));
  render();
  try {
    await api('POST', '/api/move', { keys, sprintId: sprintId ? Number(sprintId) : null });
    toast(`Moved ${keys.length} ${keys.length === 1 ? 'story' : 'stories'} to ${sprintId ? sprintById(sprintId).name : 'backlog'}`, 'ok', 1800);
  } catch (e) {
    prev.forEach(upsert);
    toast(e.message, 'err', 8000);
    render();
  }
}

async function changeStatusCategory(key, cat) {
  const i = issueByKey(key);
  if (i.statusCategory === cat) return;
  try {
    const { transitions } = await api('GET', `/api/issues/${encodeURIComponent(key)}/transitions`);
    const t = transitions.find((x) => x.category === cat);
    if (!t) { toast(`${key}: no workflow transition to "${cat}" from "${i.status}". Open the story to pick one.`, 'warn', 6000); return; }
    const r = await api('POST', `/api/issues/${encodeURIComponent(key)}/transition`, { id: t.id });
    upsert(r.issue);
    toast(`${key} → ${r.issue.status}`, 'ok', 1600);
    render();
  } catch (e) { toast(`${key}: ${e.message}`, 'err', 8000); }
}

async function handleDrop(type, value, keys) {
  if (type === 'epic') {
    const ks = keys.filter((k) => (issueByKey(k).epicKey || '') !== value);
    for (const k of ks) updateIssue(k, { epicKey: value }, { quiet: true });
    if (ks.length) toast(value ? `Linked ${ks.length} to ${value}` : `Removed epic from ${ks.length}`, 'ok', 1800);
  } else if (type === 'sprint') {
    const ks = keys.filter((k) => String(issueByKey(k).sprintId || '') !== String(value));
    if (ks.length) moveToSprint(ks, value || null);
  } else if (type === 'lane') {
    const [uid, cat] = value.split('|');
    for (const k of keys) {
      const i = issueByKey(k);
      if ((i.assignee ? i.assignee.id : '') !== uid) await updateIssue(k, { assigneeId: uid || null }, { quiet: keys.length > 1 });
      if (cat !== 'keep') await changeStatusCategory(k, cat);
    }
  }
  S.selected.clear();
}

// ---------------------------------------------------------------- compose actions
async function draftStories() {
  const text = ($('#composeText') || {}).value || '';
  if (!text.trim()) { toast('Write a few lines describing the work first'); return; }
  const btn = $('#draftBtn');
  btn.disabled = true; btn.textContent = 'Drafting…';
  try {
    const r = await api('POST', '/api/ai/draft', { text });
    const d = S.composeDefaults;
    const userByName = (n) => n && D().users.find((u) => u.name.toLowerCase().includes(n.toLowerCase()));
    S.drafts = r.stories.map((s) => ({
      ...s,
      suggestedEpic: s.epicKey,
      epicKey: d.epic === 'auto' ? s.epicKey || '' : d.epic,
      sprintId: d.sprint,
      assigneeId: (userByName(s.assigneeText) || {}).id || d.assignee,
    }));
    S.draftEngine = `Drafted by ${r.engine}`;
    S.created = [];
    render();
    toast(`${S.drafts.length} ${S.drafts.length === 1 ? 'story' : 'stories'} drafted — review and create`, 'ok');
  } catch (e) {
    toast(e.message, 'err');
    btn.disabled = false; btn.textContent = '✨ Draft stories';
  }
}

async function createDrafts() {
  const stories = S.drafts.map((s) => ({
    summary: s.summary,
    description: s.description,
    acceptanceCriteria: s.acceptanceCriteria,
    points: s.points ?? null,
    testable: s.testable,
    epicKey: s.epicKey || undefined,
    sprintId: s.sprintId ? Number(s.sprintId) : undefined,
    assigneeId: s.assigneeId || undefined,
    labels: s.labels || [],
  })).filter((s) => s.summary.trim());
  for (const s of stories) Object.keys(s).forEach((k) => s[k] === undefined && delete s[k]);
  const btn = $('[data-action="createDrafts"]');
  if (btn) { btn.disabled = true; btn.textContent = `Creating ${stories.length}…`; }
  try {
    const r = await api('POST', '/api/issues/bulk', { stories });
    S.created = r.results;
    r.results.filter((x) => x.ok).forEach((x) => upsert(x.issue));
    const failed = r.results.filter((x) => !x.ok);
    const warn = r.results.flatMap((x) => (x.warnings || []).map((w) => `${x.issue.key}: ${w}`));
    if (warn.length) toast('Created, with notes:\n• ' + [...new Set(warn)].slice(0, 8).join('\n• '), 'warn', 10000);
    S.drafts = S.drafts.filter((s) => failed.some((f) => f.summary === s.summary));
    if (!failed.length) { S.composeText = ''; ls.set('composeText', ''); }
    toast(`Created ${r.results.length - failed.length} of ${r.results.length}`, failed.length ? 'warn' : 'ok');
  } catch (e) { toast(e.message, 'err', 8000); }
  render();
}

async function quickAdd(input) {
  const text = input.value.trim();
  if (!text) return;
  input.disabled = true;
  try {
    const d = await api('POST', '/api/ai/draft', { text });
    const s = d.stories[0] || {};
    const body = {
      summary: text.length <= 90 ? text.charAt(0).toUpperCase() + text.slice(1) : s.summary,
      description: s.description,
      acceptanceCriteria: s.acceptanceCriteria,
      testable: s.testable,
      labels: s.labels,
    };
    if (input.dataset.quickaddEpic) body.epicKey = input.dataset.quickaddEpic;
    if (input.dataset.quickaddSprint) body.sprintId = Number(input.dataset.quickaddSprint);
    const r = await api('POST', '/api/issues', body);
    upsert(r.issue);
    toast(`Created ${r.issue.key} (description & acceptance criteria drafted)`, 'ok');
    render();
    const again = $(`[data-quickadd-epic="${CSS.escape(input.dataset.quickaddEpic)}"]`);
    if (again) again.focus();
  } catch (e) { toast(e.message, 'err', 8000); input.disabled = false; }
}

// ---------------------------------------------------------------- modals
function modal(html, cls = '') {
  $('#modalRoot').innerHTML = `<div class="modal-wrap" data-action="modalBg"><div class="modal ${cls}">${html}</div></div>`;
}
const closeModal = () => { $('#modalRoot').innerHTML = ''; };

function openClone(key) {
  const src = issueByKey(key);
  const next = futureSprints()[0];
  S.clone = {
    src,
    story: { summary: src.summary, description: src.description, acceptanceCriteria: [...src.acceptanceCriteria], points: src.points, testable: src.testable, epicKey: src.epicKey },
    sprintId: next ? next.id : '',
    assigneeId: '',
  };
  renderClone();
}
function renderClone() {
  const c = S.clone;
  const s = c.story;
  modal(`
    <div class="modal-head"><h2>Clone ${esc(c.src.key)} with a fresh write-up</h2><button class="x-btn" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="rewrite-bar"><input type="text" id="rewriteInstr" placeholder='What changes in the copy? e.g. "for the Android app", "replace invoices with receipts", "phase 2: bulk actions"' /><button class="btn primary" data-action="rewrite">✨ Rewrite</button></div>
      <div class="two-col">
        <div><div class="section-lbl">Original</div><div class="readonly"><b>${esc(c.src.summary)}</b>\n\n${esc(c.src.description)}${c.src.acceptanceCriteria.length ? '\n\nAcceptance criteria:\n' + c.src.acceptanceCriteria.map((a) => '• ' + esc(a)).join('\n') : ''}</div></div>
        <div style="display:flex;flex-direction:column;gap:8px">
          <div class="section-lbl">New story</div>
          <input type="text" data-cf="summary" value="${esc(s.summary)}" />
          <textarea rows="6" data-cf="description">${esc(s.description)}</textarea>
          <div class="mini-lbl">Acceptance criteria — one per line</div>
          <textarea rows="5" data-cf="acceptanceCriteria">${esc(s.acceptanceCriteria.join('\n'))}</textarea>
        </div>
      </div>
      <div class="field-grid">
        <span class="lbl">Story points</span>${seg(D().pointScale.map((p) => ({ value: p, label: p })), s.points, (v) => `data-action="clonePoints" data-v="${v.value}"`)}
        <span class="lbl">Epic</span><select data-cs="epicKey">${epicOptions(s.epicKey)}</select>
        <span class="lbl">Sprint</span><select data-cs="sprintId">${sprintOptions(c.sprintId)}</select>
        <span class="lbl">Assignee</span><select data-cs="assigneeId">${userOptions(c.assigneeId)}</select>
      </div>
    </div>
    <div class="modal-foot"><span class="hint" style="margin-right:auto">A “Cloners” link back to ${esc(c.src.key)} is added automatically</span><button class="btn" data-action="closeModal">Cancel</button><button class="btn primary" data-action="doClone">Create clone</button></div>`, 'wide');
}
function readCloneForm() {
  const s = S.clone.story;
  $$('[data-cf]').forEach((el) => { s[el.dataset.cf] = el.dataset.cf === 'acceptanceCriteria' ? el.value.split('\n').map((x) => x.trim()).filter(Boolean) : el.value; });
  $$('[data-cs]').forEach((el) => { if (el.dataset.cs === 'epicKey') s.epicKey = el.value; else S.clone[el.dataset.cs] = el.value; });
}
async function doRewrite() {
  readCloneForm();
  const instr = $('#rewriteInstr').value;
  const btn = $('[data-action="rewrite"]');
  btn.disabled = true; btn.textContent = 'Rewriting…';
  try {
    const r = await api('POST', '/api/ai/rewrite', { story: S.clone.story, instruction: instr });
    S.clone.story = { ...S.clone.story, ...r.story };
    renderClone();
    $('#rewriteInstr').value = instr;
    toast(`Rewritten (${r.engine})`, 'ok', 1800);
  } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = '✨ Rewrite'; }
}
async function doClone() {
  readCloneForm();
  const c = S.clone;
  const body = { ...c.story };
  if (c.sprintId) body.sprintId = Number(c.sprintId);
  if (c.assigneeId) body.assigneeId = c.assigneeId;
  try {
    const r = await api('POST', `/api/issues/${encodeURIComponent(c.src.key)}/clone`, body);
    upsert(r.issue);
    closeModal();
    toast(`Created ${r.issue.key} from ${c.src.key}`, 'ok');
    render();
    openDrawer(r.issue.key);
  } catch (e) { toast(e.message, 'err', 8000); }
}

function openSpillover(sprintId) {
  const from = sprintById(sprintId);
  const items = D().issues.filter((i) => String(i.sprintId) === String(sprintId) && i.statusCategory !== 'done');
  const targets = D().sprints.filter((s) => s.state === 'future' && s.id !== from.id);
  S.spill = { from, items };
  modal(`
    <div class="modal-head"><h2>↻ Spill over from ${esc(from.name)}</h2><button class="x-btn" data-action="closeModal">×</button></div>
    <div class="modal-body">
      <div class="hint">Unfinished stories are pre-selected. Untick anything that should go back to the backlog instead or stay.</div>
      <div class="check-list">${items.map((i) => `<label class="check-row"><input type="checkbox" data-spill="${esc(i.key)}" checked /><span class="key">${esc(i.key)}</span><span class="t">${esc(i.summary)}</span>${statusPill(i)}${avatar(i.assignee)}${pts(i.points)}</label>`).join('')}</div>
      <div class="field-grid">
        <span class="lbl">Move to</span><select id="spillTo">${targets.map((s) => opt(s.id, s.name, targets[0].id)).join('')}${opt('', 'Backlog', 'x')}</select>
      </div>
      <div class="opts">
        <label><input type="checkbox" id="spillLabel" checked /> Add label <span class="chip">${esc(D().spilloverLabel)}</span> (to track carry-over)</label>
        <label><input type="checkbox" id="spillComment" checked /> Add comment: <input type="text" id="spillCommentText" style="flex:1" value="Spilled over from ${esc(from.name)}." /></label>
      </div>
    </div>
    <div class="modal-foot"><span class="hint" id="spillSummary" style="margin-right:auto"></span><button class="btn" data-action="closeModal">Cancel</button><button class="btn primary" data-action="doSpill">Move stories</button></div>`);
  updateSpillSummary();
}
function updateSpillSummary() {
  const keys = $$('[data-spill]').filter((c) => c.checked).map((c) => c.dataset.spill);
  const p = sum(keys.map(issueByKey), (i) => i.points);
  const el = $('#spillSummary');
  if (el) el.textContent = `${plural(keys.length)} · ${p} pts`;
}
async function doSpill() {
  const keys = $$('[data-spill]').filter((c) => c.checked).map((c) => c.dataset.spill);
  if (!keys.length) { toast('Nothing selected'); return; }
  const to = $('#spillTo').value;
  const body = {
    keys,
    toSprintId: to ? Number(to) : null,
    fromSprintName: S.spill.from.name,
    label: $('#spillLabel').checked ? D().spilloverLabel : '',
    comment: $('#spillComment').checked ? $('#spillCommentText').value : '',
  };
  const btn = $('[data-action="doSpill"]');
  btn.disabled = true; btn.textContent = 'Moving…';
  try {
    const r = await api('POST', '/api/spillover', body);
    closeModal();
    toast(`Moved ${r.moved} stories to ${to ? sprintById(to).name : 'backlog'}`, 'ok');
    await reload(true);
  } catch (e) { toast(e.message, 'err', 8000); btn.disabled = false; btn.textContent = 'Move stories'; }
}

function copyStandup() {
  const list = filtered().filter(sprintFilter(S.teamSprint));
  const by = new Map();
  for (const i of list) {
    const n = i.assignee ? i.assignee.name : 'Unassigned';
    if (!by.has(n)) by.set(n, []);
    by.get(n).push(i);
  }
  const lines = [];
  const sp = sprintById(S.teamSprint);
  lines.push(`Stand-up – ${sp ? sp.name : 'Open work'} – ${new Date().toLocaleDateString()}`);
  for (const [n, items] of by) {
    lines.push('', `${n} (${sum(items, (i) => i.points)} pts)`);
    for (const c of ['inprogress', 'todo', 'done']) {
      for (const i of items.filter((x) => x.statusCategory === c)) lines.push(`  • [${i.status}] ${i.key} ${i.summary}${i.points != null ? ` (${i.points})` : ''}`);
    }
  }
  const text = lines.join('\n');
  (navigator.clipboard ? navigator.clipboard.writeText(text) : Promise.reject()).then(
    () => toast('Stand-up summary copied — paste it into Teams/Slack/email', 'ok'),
    () => { modal(`<div class="modal-head"><h2>Stand-up summary</h2><button class="x-btn" data-action="closeModal">×</button></div><div class="modal-body"><textarea rows="18">${esc(text)}</textarea></div>`); },
  );
}

// ---------------------------------------------------------------- sizing actions
function sizeCurrent(p) {
  const key = S.sizingKey;
  if (!key) return;
  const i = issueByKey(key);
  const before = i.points;
  const all = sizingQueue();
  const queue = S.sizingOnlyUnsized ? all.filter((x) => x.points == null || x.key === key) : all;
  const idx = queue.findIndex((x) => x.key === key);
  const next = queue[idx + 1] || queue[idx - 1];
  if (before == null && p != null) S.sizedThisSession++;
  S.sizingKey = next ? next.key : null;
  updateIssue(key, { points: p }, { quiet: true });
  toast(`${key} = ${p ?? '–'} pts`, 'ok', 1100);
}
function sizeNav(dir) {
  const all = sizingQueue();
  const queue = S.sizingOnlyUnsized ? all.filter((x) => x.points == null || x.key === S.sizingKey) : all;
  const idx = queue.findIndex((x) => x.key === S.sizingKey);
  const n = queue[(idx + dir + queue.length) % queue.length];
  if (n) { S.sizingKey = n.key; render(); }
}

// ---------------------------------------------------------------- event wiring
const actions = {
  open: (el) => openDrawer(el.dataset.key),
  closeDrawer,
  closeModal,
  modalBg: (el, e) => { if (e.target === el) closeModal(); },
  createEpic: async () => {
    const name = $('#newEpicName').value.trim();
    if (!name) return;
    try {
      const r = await api('POST', '/api/epics', { summary: name });
      D().epics.push(r.epic);
      toast(`Epic ${r.epic.key} created`, 'ok');
      render();
    } catch (e) { toast(e.message, 'err', 8000); }
  },
  spillover: (el) => openSpillover(el.dataset.sprint),
  doSpill,
  draft: draftStories,
  createDrafts,
  clearDrafts: () => { S.drafts = []; render(); },
  removeDraft: (el) => { S.drafts.splice(Number(el.dataset.idx), 1); render(); },
  draftPoints: (el) => { const d = S.drafts[el.dataset.idx]; d.points = Number(el.dataset.v); render(); },
  draftTestable: (el) => { S.drafts[el.dataset.idx].testable = el.dataset.v === 'true'; render(); },
  size: (el) => sizeCurrent(Number(el.dataset.v)),
  sizeNav: (el) => sizeNav(Number(el.dataset.dir)),
  sizePick: (el) => { S.sizingKey = el.dataset.key; render(); },
  copyStandup,
  dPoints: (el) => updateIssue(S.drawerKey, { points: el.dataset.v === '' ? null : Number(el.dataset.v) }),
  dTestable: (el) => updateIssue(S.drawerKey, { testable: el.dataset.v === 'true' }),
  saveDrawer: async () => {
    const d = { ...S.drawerDirty };
    if ('acceptanceCriteria' in d) d.acceptanceCriteria = d.acceptanceCriteria.split('\n').map((x) => x.trim()).filter(Boolean);
    S.drawerDirty = {};
    await updateIssue(S.drawerKey, d);
  },
  clone: (el) => openClone(el.dataset.key),
  rewrite: doRewrite,
  doClone,
  clonePoints: (el) => { readCloneForm(); S.clone.story.points = Number(el.dataset.v); renderClone(); },
};

document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (a && actions[a.dataset.action]) { actions[a.dataset.action](a, e); return; }
  const c = e.target.closest('.card');
  if (c) {
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      S.selected.has(c.dataset.key) ? S.selected.delete(c.dataset.key) : S.selected.add(c.dataset.key);
      c.classList.toggle('selected');
    } else openDrawer(c.dataset.key);
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.change) {
    const k = t.dataset.change;
    S[k] = t.type === 'checkbox' ? t.checked : t.value;
    if (['planSprint', 'sizingSprint'].includes(k)) ls.set(k, S[k]);
    render();
  } else if (t.dataset.composeDefault) {
    S.composeDefaults[t.dataset.composeDefault] = t.value;
    ls.set('composeDefaults', S.composeDefaults);
    const f = { epic: 'epicKey', sprint: 'sprintId', assignee: 'assigneeId' }[t.dataset.composeDefault];
    if (S.drafts.length) {
      S.drafts.forEach((d) => { d[f] = t.value === 'auto' ? d.suggestedEpic || '' : t.value; });
      render();
    }
  } else if (t.dataset.dfield && t.tagName === 'SELECT') {
    S.drafts[t.closest('[data-draft]').dataset.draft][t.dataset.dfield] = t.value;
  } else if (t.dataset.dsel) {
    const v = t.value;
    if (t.dataset.dsel === 'sprintId') moveToSprint([S.drawerKey], v || null);
    else updateIssue(S.drawerKey, { [t.dataset.dsel]: v || (t.dataset.dsel === 'epicKey' ? '' : null) });
  } else if (t.dataset.transition !== undefined && t.value) {
    const key = S.drawerKey;
    api('POST', `/api/issues/${encodeURIComponent(key)}/transition`, { id: t.value })
      .then((r) => { upsert(r.issue); toast(`${key} → ${r.issue.status}`, 'ok'); render(); return api('GET', `/api/issues/${encodeURIComponent(key)}/transitions`); })
      .then((r) => { S.transitions = r.transitions; renderDrawerStatus(); })
      .catch((err) => toast(err.message, 'err', 8000));
  } else if (t.dataset.capacity) {
    S.capacity[t.dataset.capacity] = Number(t.value) || 0;
    ls.set('capacity', S.capacity);
    render();
  } else if (t.dataset.spill !== undefined) updateSpillSummary();
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'search') { S.search = t.value; render(); return; }
  if (t.id === 'composeText') { S.composeText = t.value; ls.set('composeText', t.value); return; }
  if (t.dataset.dfield && t.tagName !== 'SELECT') {
    const d = S.drafts[t.closest('[data-draft]').dataset.draft];
    d[t.dataset.dfield] = t.dataset.dfield === 'acceptanceCriteria' ? t.value.split('\n').map((x) => x.trim()).filter(Boolean) : t.value;
    return;
  }
  if (t.dataset.dd) {
    const i = issueByKey(S.drawerKey);
    const orig = t.dataset.dd === 'acceptanceCriteria' ? i.acceptanceCriteria.join('\n') : i[t.dataset.dd];
    if (t.value === orig) delete S.drawerDirty[t.dataset.dd]; else S.drawerDirty[t.dataset.dd] = t.value;
    const b = $('[data-action="saveDrawer"]');
    if (b) b.disabled = !Object.keys(S.drawerDirty).length;
  }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toLowerCase();
  const typing = ['input', 'textarea', 'select'].includes(tag);
  if (e.key === 'Enter' && e.target.dataset && e.target.dataset.quickaddEpic !== undefined) { e.preventDefault(); quickAdd(e.target); return; }
  if (e.key === 'Enter' && e.target.id === 'newEpicName') { actions.createEpic(); return; }
  if (e.key === 'Enter' && e.target.id === 'rewriteInstr') { doRewrite(); return; }
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'composeText') { draftStories(); return; }
  if (e.key === 'Escape') {
    if ($('#modalRoot').innerHTML) closeModal();
    else if (S.drawerKey) closeDrawer();
    else if (typing) e.target.blur();
    else if (S.selected.size) { S.selected.clear(); render(); }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey || $('#modalRoot').innerHTML) return;
  if (S.view === 'sizing' && !S.drawerKey) {
    const scale = D().pointScale;
    if (/^[1-9]$/.test(e.key) && scale[Number(e.key) - 1] !== undefined) { sizeCurrent(scale[Number(e.key) - 1]); return; }
    if (e.key === '0') { sizeCurrent(null); return; }
    if (e.key === 'ArrowRight') { sizeNav(1); return; }
    if (e.key === 'ArrowLeft') { sizeNav(-1); return; }
  }
  if (S.drawerKey) return;
  if (e.key === '/') { e.preventDefault(); $('#search').focus(); }
  else if (e.key === 'n' || e.key === 'N') { e.preventDefault(); setView('compose'); }
  else if (e.key === 'r' || e.key === 'R') reload(true);
  else if (/^[1-5]$/.test(e.key) && S.view !== 'sizing') setView(['plan', 'sprints', 'compose', 'sizing', 'team'][Number(e.key) - 1]);
});

// drag & drop
let dragKeys = [];
document.addEventListener('dragstart', (e) => {
  const c = e.target.closest && e.target.closest('.card');
  if (!c) return;
  const k = c.dataset.key;
  dragKeys = S.selected.has(k) ? [...S.selected] : [k];
  e.dataTransfer.setData('text/plain', dragKeys.join(','));
  e.dataTransfer.effectAllowed = 'move';
  requestAnimationFrame(() => dragKeys.forEach((key) => { const el = $(`.card[data-key="${CSS.escape(key)}"]`); if (el) el.classList.add('dragging'); }));
});
document.addEventListener('dragend', () => { $$('.dragging').forEach((x) => x.classList.remove('dragging')); $$('.over').forEach((x) => x.classList.remove('over')); });
document.addEventListener('dragover', (e) => {
  const z = e.target.closest && e.target.closest('[data-drop]');
  if (!z || !dragKeys.length) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  if (!z.classList.contains('over')) { $$('.over').forEach((x) => x.classList.remove('over')); z.classList.add('over'); }
});
document.addEventListener('dragleave', (e) => {
  const z = e.target.closest && e.target.closest('[data-drop]');
  if (z && !z.contains(e.relatedTarget)) z.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  const z = e.target.closest && e.target.closest('[data-drop]');
  if (!z) return;
  e.preventDefault();
  z.classList.remove('over');
  const keys = dragKeys;
  dragKeys = [];
  handleDrop(z.dataset.drop, z.dataset.value, keys);
});

$('#nav').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
$('#drawerBackdrop').addEventListener('click', closeDrawer);
$('#newStoryBtn').addEventListener('click', () => setView('compose'));
$('#refreshBtn').addEventListener('click', () => reload(true));
$('#themeBtn').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  ls.set('theme', next);
});
if (ls.get('theme')) document.documentElement.dataset.theme = ls.get('theme');
if (VIEWS[location.hash.slice(1)]) S.view = location.hash.slice(1);
window.addEventListener('hashchange', () => { if (VIEWS[location.hash.slice(1)] && location.hash.slice(1) !== S.view) setView(location.hash.slice(1)); });

// ---------------------------------------------------------------- boot
async function reload(announce) {
  try {
    S.data = await api('GET', '/api/bootstrap');
    $('#projectLabel').textContent = `${S.data.projectKey} · ${S.data.info.board}`;
    $('#modeBadge').innerHTML = S.data.mode === 'jira'
      ? `<span class="dot" style="background:var(--ok)"></span>Live Jira · ${esc(S.data.info.user || '')}`
      : '<span class="dot" style="background:var(--warn)"></span>Demo mode (sample data)';
    $('#aiBadge').innerHTML = `<span class="dot" style="background:${S.data.ai.enabled ? 'var(--accent)' : 'var(--text-3)'}"></span>Drafting: ${esc(S.data.ai.status)}`;
    render();
    if (announce) toast(`Loaded ${S.data.issues.length} stories`, 'ok', 1500);
  } catch (e) {
    $('#view').innerHTML = `<div class="empty">Could not load data: ${esc(e.message)}<br><br>Check the terminal running <code>node server.js</code> for details.</div>`;
  }
}
reload();
