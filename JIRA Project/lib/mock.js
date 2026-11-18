'use strict';
/**
 * Demo adapter: same interface as JiraAdapter, backed by data/demo-db.json.
 * Lets you try every feature without Jira access. Delete data/demo-db.json to reset.
 */
const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const DB_FILE = path.join(ROOT, 'data', 'demo-db.json');

const STATUSES = [
  { name: 'To Do', category: 'todo' },
  { name: 'In Progress', category: 'inprogress' },
  { name: 'In Review', category: 'inprogress' },
  { name: 'Done', category: 'done' },
];

function seed() {
  const users = [
    { id: 'u1', name: 'Priya Sharma' },
    { id: 'u2', name: 'Daniel Okafor' },
    { id: 'u3', name: 'Mei Chen' },
    { id: 'u4', name: 'Lucas Romero' },
    { id: 'u5', name: 'Aisha Khan' },
    { id: 'u6', name: 'Tom Becker' },
  ];
  const sprints = [
    { id: 101, name: 'Sprint 24', state: 'active', startDate: '2026-11-10', endDate: '2026-11-24', goal: 'Self-service onboarding live for pilot customers' },
    { id: 102, name: 'Sprint 25', state: 'future', goal: '' },
    { id: 103, name: 'Sprint 26', state: 'future', goal: '' },
  ];
  const epics = [
    { key: 'DEMO-1', summary: 'Customer self-service onboarding' },
    { key: 'DEMO-2', summary: 'Billing & invoices revamp' },
    { key: 'DEMO-3', summary: 'Reporting dashboard' },
    { key: 'DEMO-4', summary: 'Single sign-on (SSO) and security' },
    { key: 'DEMO-5', summary: 'Mobile app performance' },
  ];
  const S = (summary, o = {}) => ({ summary, ...o });
  const stories = [
    S('Signup form with email verification', { epicKey: 'DEMO-1', sprintId: 101, points: 5, status: 'Done', assignee: 'u1', testable: true }),
    S('Welcome tour for first login', { epicKey: 'DEMO-1', sprintId: 101, points: 3, status: 'In Progress', assignee: 'u3', testable: true }),
    S('Company profile setup wizard', { epicKey: 'DEMO-1', sprintId: 101, points: 8, status: 'In Review', assignee: 'u2', testable: true }),
    S('Invite teammates by email', { epicKey: 'DEMO-1', sprintId: 101, points: 3, status: 'To Do', assignee: 'u5', testable: true }),
    S('Download invoices as PDF', { epicKey: 'DEMO-2', sprintId: 101, points: 5, status: 'In Progress', assignee: 'u4', testable: true }),
    S('Show tax breakdown on invoice', { epicKey: 'DEMO-2', sprintId: 101, points: 3, status: 'To Do', assignee: 'u4', testable: true }),
    S('Spike: evaluate payment provider APIs', { epicKey: 'DEMO-2', sprintId: 101, points: 2, status: 'Done', assignee: 'u6', testable: false }),
    S('SAML login with Azure AD', { epicKey: 'DEMO-4', sprintId: 101, points: 13, status: 'In Progress', assignee: 'u2', testable: true }),
    S('Weekly usage chart on dashboard', { epicKey: 'DEMO-3', sprintId: 102, points: 5, status: 'To Do', assignee: 'u3', testable: true }),
    S('Export dashboard to CSV', { epicKey: 'DEMO-3', sprintId: 102, points: 3, status: 'To Do', testable: true }),
    S('Filter dashboard by team', { epicKey: 'DEMO-3', sprintId: 102, status: 'To Do' }),
    S('Enforce MFA for admin roles', { epicKey: 'DEMO-4', sprintId: 102, points: 8, status: 'To Do', assignee: 'u6', testable: true }),
    S('Lazy-load images on product list', { epicKey: 'DEMO-5', sprintId: 102, points: 3, status: 'To Do', assignee: 'u1' }),
    S('Reduce app cold start time below 2s', { epicKey: 'DEMO-5', status: 'To Do' }),
    S('Offline mode for order history', { epicKey: 'DEMO-5', status: 'To Do' }),
    S('Session timeout warning banner', { status: 'To Do' }),
    S('Dark mode for settings page', { status: 'To Do' }),
    S('Audit log for permission changes', { status: 'To Do', points: 5 }),
    S('Retry failed webhook deliveries', { status: 'To Do' }),
    S('Bulk edit user roles', { sprintId: 103, status: 'To Do' }),
  ];
  let n = 6;
  const issues = stories.map((s) => {
    const key = `DEMO-${n++}`;
    const st = STATUSES.find((x) => x.name === s.status) || STATUSES[0];
    return {
      key,
      summary: s.summary,
      description: `As a user, I want to ${s.summary.toLowerCase()}, so that my day-to-day work is easier.\n\nContext:\nDemo story generated for SprintPilot.`,
      acceptanceCriteria: [
        `Given I am signed in, When I use "${s.summary}", Then it works as described`,
        'Given invalid input, When I submit, Then I see a clear validation message',
      ],
      status: st.name,
      statusCategory: st.category,
      assigneeId: s.assignee || null,
      points: s.points ?? null,
      epicKey: s.epicKey || '',
      sprintId: s.sprintId || null,
      testable: s.testable ?? null,
      labels: [],
      issueType: 'Story',
      updated: new Date().toISOString(),
    };
  });
  return { users, sprints, epics, issues, nextKey: n, comments: {} };
}

class MockAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.db = null;
  }

  load() {
    if (this.db) return this.db;
    try { this.db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { this.db = seed(); this.save(); }
    return this.db;
  }

  save() {
    fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify(this.db, null, 2));
  }

  async init() {
    this.load();
    return this.describe();
  }

  describe() {
    return {
      jira: 'DEMO MODE (no Jira connection) – data in data/demo-db.json',
      user: 'Demo user',
      board: 'Demo board',
      fields: { storyPoints: 'demo', sprint: 'demo', epicLink: 'demo', acceptanceCriteria: 'demo', testable: 'demo' },
      notes: [],
    };
  }

  out(i) {
    const db = this.load();
    const u = db.users.find((x) => x.id === i.assigneeId);
    const sp = db.sprints.find((s) => s.id === i.sprintId);
    return {
      key: i.key,
      summary: i.summary,
      description: i.description,
      acceptanceCriteria: i.acceptanceCriteria || [],
      status: i.status,
      statusCategory: i.statusCategory,
      assignee: u ? { ...u } : null,
      points: i.points,
      epicKey: i.epicKey || '',
      sprintId: sp ? sp.id : null,
      sprintName: sp ? sp.name : '',
      sprintHistory: i.sprintHistory || [],
      testable: i.testable,
      labels: i.labels || [],
      issueType: i.issueType || 'Story',
      priority: 'Medium',
      updated: i.updated,
      url: `#${i.key}`,
    };
  }

  find(key) {
    const i = this.load().issues.find((x) => x.key === key);
    if (!i) { const e = new Error(`Issue ${key} not found`); e.status = 404; throw e; }
    return i;
  }

  async listIssues() { return this.load().issues.map((i) => this.out(i)); }
  async getIssue(key) { return this.out(this.find(key)); }

  async getContext() {
    const db = this.load();
    return {
      sprints: db.sprints.map((s) => ({ ...s })),
      epics: db.epics.map((e) => ({ ...e, status: 'In Progress', url: `#${e.key}` })),
      users: db.users.map((u) => ({ ...u })),
    };
  }

  apply(i, input) {
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
    for (const k of ['summary', 'description', 'acceptanceCriteria', 'points', 'epicKey', 'testable']) {
      if (has(k)) i[k] = input[k] === undefined ? null : input[k];
    }
    if (has('points')) i.points = input.points === null || input.points === '' ? null : Number(input.points);
    if (has('assigneeId')) i.assigneeId = input.assigneeId || null;
    if (has('sprintId')) i.sprintId = input.sprintId || null;
    if (has('labels') && Array.isArray(input.labels)) i.labels = [...new Set(input.labels)];
    if (has('addLabels')) i.labels = [...new Set([...(i.labels || []), ...input.addLabels])];
    i.updated = new Date().toISOString();
  }

  async createIssue(input) {
    const db = this.load();
    const i = {
      key: `DEMO-${db.nextKey++}`,
      summary: '', description: '', acceptanceCriteria: [], status: 'To Do', statusCategory: 'todo',
      assigneeId: null, points: null, epicKey: '', sprintId: null, testable: null, labels: [], issueType: input.issueType || 'Story',
    };
    this.apply(i, input);
    db.issues.push(i);
    this.save();
    return { issue: this.out(i), warnings: [] };
  }

  async updateIssue(key, input) {
    const i = this.find(key);
    this.apply(i, input);
    this.save();
    return { issue: this.out(i), warnings: [] };
  }

  async moveToSprint(keys, sprintId) {
    for (const k of keys) this.find(k).sprintId = sprintId || null;
    this.save();
  }

  async cloneIssue(key, overrides) {
    const src = this.out(this.find(key));
    const r = await this.createIssue({
      summary: src.summary, description: src.description, acceptanceCriteria: src.acceptanceCriteria,
      points: src.points, epicKey: src.epicKey, testable: src.testable, labels: src.labels.filter((l) => l !== this.cfg.jira.spilloverLabel), ...overrides,
    });
    return r;
  }

  async spillover({ keys, toSprintId, fromSprintName, label, comment }) {
    const db = this.load();
    for (const k of keys) {
      const i = this.find(k);
      if (fromSprintName) i.sprintHistory = [...(i.sprintHistory || []), fromSprintName];
      i.sprintId = toSprintId;
      if (label) i.labels = [...new Set([...(i.labels || []), label])];
      if (comment) (db.comments[k] = db.comments[k] || []).push(comment.replace('{from}', fromSprintName || 'previous sprint'));
    }
    this.save();
    return { moved: keys.length, warnings: [] };
  }

  async getTransitions(key) {
    const i = this.find(key);
    return STATUSES.filter((s) => s.name !== i.status).map((s, idx) => ({ id: s.name, name: s.name, to: s.name, category: s.category, idx }));
  }

  async transition(key, id) {
    const i = this.find(key);
    const st = STATUSES.find((s) => s.name === id);
    if (st) { i.status = st.name; i.statusCategory = st.category; }
    this.save();
    return { issue: this.out(i), warnings: [] };
  }

  async createEpic({ summary }) {
    const db = this.load();
    const e = { key: `DEMO-${db.nextKey++}`, summary };
    db.epics.push(e);
    this.save();
    return { epic: { ...e, status: 'To Do', url: `#${e.key}` }, warnings: [] };
  }
}

module.exports = { MockAdapter };
