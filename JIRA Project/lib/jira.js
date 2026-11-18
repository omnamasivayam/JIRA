'use strict';
/**
 * Jira adapter (Cloud + Server/Data Center).
 * Talks to Jira REST v2 (plain-text/wiki descriptions on both Cloud and Server) and the Agile REST API.
 * Custom field IDs (story points, sprint, epic link, acceptance criteria, testable) are auto-discovered
 * at startup, or can be pinned in config.json -> jira.fields.
 */
const T = require('./storyText');

class JiraError extends Error {
  constructor(status, body, method, path) {
    const msgs = [];
    if (body && Array.isArray(body.errorMessages)) msgs.push(...body.errorMessages);
    if (body && body.errors && typeof body.errors === 'object') {
      for (const [k, v] of Object.entries(body.errors)) msgs.push(`${k}: ${v}`);
    }
    if (!msgs.length && body && body.message) msgs.push(body.message);
    if (!msgs.length && typeof body === 'string') msgs.push(body.slice(0, 300));
    super(`Jira ${status} on ${method} ${path}${msgs.length ? ' – ' + msgs.join('; ') : ''}`);
    this.status = status;
    this.body = body;
    this.fieldErrors = (body && body.errors) || {};
  }
}

const CAT = { new: 'todo', indeterminate: 'inprogress', done: 'done' };

class JiraAdapter {
  constructor(cfg) {
    this.cfg = cfg;
    this.j = cfg.jira;
    this.isCloud = this.j.deployment === 'cloud';
    this.f = {}; // discovered field metadata: { storyPoints, sprint, epicLink, epicName, acceptanceCriteria, testable }
    this.modes = {};
    this.discoveryNotes = [];
  }

  // ---------- HTTP ----------
  authHeader() {
    const type = this.j.authType === 'auto' ? (this.isCloud || this.j.email ? 'basic' : 'bearer') : this.j.authType;
    if (type === 'bearer') return `Bearer ${this.j.apiToken}`;
    return 'Basic ' + Buffer.from(`${this.j.email}:${this.j.apiToken}`).toString('base64');
  }

  async req(method, path, body) {
    const res = await fetch(this.j.baseUrl + path, {
      method,
      headers: {
        Authorization: this.authHeader(),
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'X-Atlassian-Token': 'no-check',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!res.ok) throw new JiraError(res.status, data, method, path);
    return data;
  }

  // ---------- Startup discovery ----------
  async init() {
    const me = await this.req('GET', '/rest/api/2/myself');
    this.me = { id: me.accountId || me.name, name: me.displayName };

    const fields = await this.req('GET', '/rest/api/2/field');
    const byCustom = (t) => fields.find((f) => f.schema && f.schema.custom === t);
    const byName = (re) => fields.find((f) => re.test(f.name));
    const pick = (conf, auto, label) => {
      if (conf && conf !== 'auto') {
        const found = fields.find((f) => f.id === conf || f.name.toLowerCase() === String(conf).toLowerCase());
        if (!found) this.discoveryNotes.push(`Configured ${label} field "${conf}" not found in Jira`);
        return found || { id: conf, name: conf, schema: {} };
      }
      return auto || null;
    };
    const F = this.j.fields || {};

    let spFromBoard = null;
    try {
      const bc = await this.req('GET', `/rest/agile/1.0/board/${this.j.boardId}/configuration`);
      const id = bc && bc.estimation && bc.estimation.field && bc.estimation.field.fieldId;
      if (id) spFromBoard = fields.find((f) => f.id === id) || null;
      this.boardName = bc && bc.name;
    } catch (e) {
      this.discoveryNotes.push(`Could not read board ${this.j.boardId} configuration: ${e.message}`);
    }

    this.f.storyPoints = pick(F.storyPoints, spFromBoard || byName(/^story points?$/i) || byName(/^story point estimate$/i), 'storyPoints');
    this.f.sprint = pick(F.sprint, byCustom('com.pyxis.greenhopper.jira:gh-sprint') || byName(/^sprint$/i), 'sprint');
    this.f.epicLink = pick(F.epicLink, byCustom('com.pyxis.greenhopper.jira:gh-epic-link') || byName(/^epic link$/i), 'epicLink');
    this.f.epicName = byCustom('com.pyxis.greenhopper.jira:gh-epic-label') || byName(/^epic name$/i) || null;
    this.f.acceptanceCriteria = pick(F.acceptanceCriteria, byName(/acceptance criteria/i), 'acceptanceCriteria');
    this.f.testable = pick(F.testable, byName(/^testable\??$/i) || byName(/testable/i), 'testable');

    const style = this.j.epicLinkStyle;
    this.modes.epic = style && style !== 'auto' ? style : (this.isCloud || !this.f.epicLink ? 'parent' : 'epicLink');
    const acm = this.j.acceptanceCriteriaMode;
    this.modes.ac = acm && acm !== 'auto' ? acm : (this.f.acceptanceCriteria ? 'field' : 'description');
    const tm = this.j.testable.mode;
    this.modes.testable = tm && tm !== 'auto' ? tm : (this.f.testable ? 'field' : 'label');

    if (!this.f.storyPoints) this.discoveryNotes.push('No story points field found – sizing will not save. Set jira.fields.storyPoints in config.json');
    return this.describe();
  }

  describe() {
    const show = (x) => (x ? `${x.name} (${x.id})` : '—');
    return {
      jira: `${this.j.baseUrl} (${this.isCloud ? 'Cloud' : 'Server/DC'})`,
      user: this.me && this.me.name,
      board: `${this.boardName || ''} #${this.j.boardId}`,
      fields: {
        storyPoints: show(this.f.storyPoints),
        sprint: show(this.f.sprint),
        epicLink: this.modes.epic === 'parent' ? 'parent field' : show(this.f.epicLink),
        acceptanceCriteria: this.modes.ac === 'field' ? show(this.f.acceptanceCriteria) : 'inside Description',
        testable: this.modes.testable === 'field' ? show(this.f.testable) : `labels "${this.j.testable.yesLabel}" / "${this.j.testable.noLabel}"`,
      },
      notes: this.discoveryNotes,
    };
  }

  fieldIds() {
    return [
      'summary', 'description', 'status', 'assignee', 'issuetype', 'labels', 'priority', 'updated', 'created', 'parent',
      this.f.storyPoints && this.f.storyPoints.id,
      this.f.sprint && this.f.sprint.id,
      this.f.epicLink && this.f.epicLink.id,
      this.f.acceptanceCriteria && this.f.acceptanceCriteria.id,
      this.f.testable && this.f.testable.id,
    ].filter(Boolean);
  }

  // ---------- Normalisation ----------
  user(u) {
    if (!u) return null;
    return { id: u.accountId || u.name || u.key, name: u.displayName || u.name };
  }

  parseSprints(v) {
    const arr = Array.isArray(v) ? v : v ? [v] : [];
    return arr.map((s) => {
      if (typeof s === 'string') {
        const g = (k) => ((new RegExp(`${k}=([^,\\]]*)`).exec(s) || [])[1]);
        return { id: Number(g('id')), name: g('name'), state: String(g('state') || '').toLowerCase() };
      }
      return { id: s.id, name: s.name, state: String(s.state || '').toLowerCase() };
    }).filter((s) => s.id);
  }

  parseTestable(v) {
    if (v === null || v === undefined || v === '') return null;
    const yes = (x) => /^(y|yes|true|1|testable)$/i.test(String(x).trim());
    if (Array.isArray(v)) return v.length ? v.some((o) => yes(o && typeof o === 'object' ? o.value : o)) : null;
    if (typeof v === 'object') return yes(v.value);
    if (typeof v === 'boolean') return v;
    return yes(v);
  }

  normalize(issue) {
    const f = issue.fields || {};
    const get = (meta) => (meta ? f[meta.id] : undefined);
    const sprints = this.parseSprints(get(this.f.sprint));
    const sprint = sprints.find((s) => s.state === 'active') || sprints.find((s) => s.state === 'future') || sprints[sprints.length - 1] || null;

    let description = typeof f.description === 'string' ? f.description : '';
    let ac = [];
    if (this.modes.ac === 'field') {
      const raw = get(this.f.acceptanceCriteria);
      ac = T.parseAcText(typeof raw === 'string' ? raw : raw && raw.value ? raw.value : '');
      if (!ac.length) {
        const split = T.splitDescriptionAndAc(description);
        if (split.acceptanceCriteria.length) { description = split.description; ac = split.acceptanceCriteria; }
      }
    } else {
      const split = T.splitDescriptionAndAc(description);
      description = split.description;
      ac = split.acceptanceCriteria;
    }

    let epicKey = '';
    if (f.parent && f.parent.key) epicKey = f.parent.key;
    const el = get(this.f.epicLink);
    if (!epicKey && el) epicKey = typeof el === 'string' ? el : el.key || '';

    const labels = f.labels || [];
    let testable = null;
    if (this.modes.testable === 'field') testable = this.parseTestable(get(this.f.testable));
    else if (labels.includes(this.j.testable.yesLabel)) testable = true;
    else if (labels.includes(this.j.testable.noLabel)) testable = false;

    const sp = get(this.f.storyPoints);
    return {
      key: issue.key,
      id: issue.id,
      summary: f.summary || '',
      description,
      acceptanceCriteria: ac,
      status: f.status ? f.status.name : '',
      statusCategory: f.status && f.status.statusCategory ? (CAT[f.status.statusCategory.key] || 'todo') : 'todo',
      assignee: this.user(f.assignee),
      points: sp === null || sp === undefined || sp === '' ? null : Number(sp),
      epicKey,
      sprintId: sprint ? sprint.id : null,
      sprintName: sprint ? sprint.name : '',
      sprintHistory: sprints.map((s) => s.name),
      testable,
      labels,
      issueType: f.issuetype ? f.issuetype.name : '',
      priority: f.priority ? f.priority.name : '',
      updated: f.updated,
      url: `${this.j.baseUrl}/browse/${issue.key}`,
    };
  }

  // ---------- Reading ----------
  async search(jql, max = this.j.maxResults || 500) {
    const fields = this.fieldIds();
    const out = [];
    if (this.isCloud) {
      let nextPageToken;
      do {
        const body = { jql, fields, maxResults: 100 };
        if (nextPageToken) body.nextPageToken = nextPageToken;
        const r = await this.req('POST', '/rest/api/2/search/jql', body);
        out.push(...(r.issues || []));
        nextPageToken = r.isLast === false || (r.nextPageToken && r.isLast !== true) ? r.nextPageToken : null;
      } while (nextPageToken && out.length < max);
    } else {
      let startAt = 0;
      for (;;) {
        const r = await this.req('POST', '/rest/api/2/search', { jql, fields, startAt, maxResults: 100 });
        out.push(...(r.issues || []));
        startAt += (r.issues || []).length;
        if (!r.issues || !r.issues.length || startAt >= r.total || out.length >= max) break;
      }
    }
    return out.slice(0, max);
  }

  async listIssues() {
    const p = this.j.projectKey;
    const jql = (this.j.storyJql && this.j.storyJql.trim()
      ? this.j.storyJql
      : `project = "{project}" AND issuetype != "${this.j.epicIssueType}" AND issuetype not in subTaskIssueTypes() AND (statusCategory != Done OR updated >= -21d) ORDER BY Rank ASC`
    ).replace(/\{project\}/g, p);
    const raw = await this.search(jql);
    return raw.map((i) => this.normalize(i));
  }

  async getIssue(key) {
    const r = await this.req('GET', `/rest/api/2/issue/${encodeURIComponent(key)}?fields=${this.fieldIds().join(',')}`);
    return this.normalize(r);
  }

  async listEpics() {
    const raw = await this.search(`project = "${this.j.projectKey}" AND issuetype = "${this.j.epicIssueType}" AND statusCategory != Done ORDER BY Rank ASC`, 200);
    return raw.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status ? i.fields.status.name : '', url: `${this.j.baseUrl}/browse/${i.key}` }));
  }

  async listSprints() {
    const out = [];
    let startAt = 0;
    for (;;) {
      const r = await this.req('GET', `/rest/agile/1.0/board/${this.j.boardId}/sprint?state=active,future&startAt=${startAt}&maxResults=50`);
      out.push(...(r.values || []));
      if (r.isLast || !r.values || !r.values.length) break;
      startAt += r.values.length;
    }
    return out.map((s) => ({ id: s.id, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate, goal: s.goal || '' }))
      .sort((a, b) => (a.state === b.state ? a.id - b.id : a.state === 'active' ? -1 : 1));
  }

  async listUsers() {
    const p = encodeURIComponent(this.j.projectKey);
    try {
      const path = this.isCloud
        ? `/rest/api/2/user/assignable/search?project=${p}&maxResults=1000`
        : `/rest/api/2/user/assignable/search?project=${p}&username=&maxResults=1000`;
      const r = await this.req('GET', path);
      return (r || []).filter((u) => u.active !== false && (u.accountType ? u.accountType === 'atlassian' : true)).map((u) => this.user(u));
    } catch (e) {
      this.discoveryNotes.push(`Could not list assignable users (${e.message}); using assignees seen on issues`);
      return [];
    }
  }

  async getContext() {
    const [sprints, epics, users] = await Promise.all([this.listSprints(), this.listEpics(), this.listUsers()]);
    return { sprints, epics, users };
  }

  // ---------- Writing ----------
  testableValue(yes) {
    const meta = this.f.testable;
    const t = this.j.testable;
    const type = meta && meta.schema ? meta.schema.type : 'option';
    if (yes === null || yes === undefined) return null;
    if (type === 'array') return yes ? [{ value: t.yesValue }] : [];
    if (type === 'option') return { value: yes ? t.yesValue : t.noValue };
    if (type === 'number') return yes ? 1 : 0;
    return yes ? t.yesValue : t.noValue;
  }

  /** Build {fields, update} for create/edit from the app's simple story shape. Only keys present in input are touched. */
  buildPayload(input, current) {
    const fields = {};
    const update = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k);

    if (has('summary')) fields.summary = String(input.summary).slice(0, 254);

    if (this.modes.ac === 'field') {
      if (has('description')) fields.description = input.description || '';
      if (has('acceptanceCriteria') && this.f.acceptanceCriteria) fields[this.f.acceptanceCriteria.id] = T.acToText(input.acceptanceCriteria);
    } else if (has('description') || has('acceptanceCriteria')) {
      const d = has('description') ? input.description : current ? current.description : '';
      const ac = has('acceptanceCriteria') ? input.acceptanceCriteria : current ? current.acceptanceCriteria : [];
      fields.description = T.joinDescriptionAndAc(d, ac);
    }

    if (has('points') && this.f.storyPoints) fields[this.f.storyPoints.id] = input.points === null || input.points === '' ? null : Number(input.points);

    if (has('epicKey') && input.epicKey) {
      if (this.modes.epic === 'parent') fields.parent = { key: input.epicKey };
      else if (this.f.epicLink) fields[this.f.epicLink.id] = input.epicKey;
    }

    if (has('assigneeId')) {
      fields.assignee = input.assigneeId ? (this.isCloud ? { accountId: input.assigneeId } : { name: input.assigneeId }) : null;
    }

    const labelsAdd = new Set(has('labels') && !current ? input.labels || [] : []);
    const labelsRemove = new Set();
    if (has('testable') && input.testable !== null && input.testable !== undefined) {
      if (this.modes.testable === 'field' && this.f.testable) {
        fields[this.f.testable.id] = this.testableValue(!!input.testable);
      } else {
        const t = this.j.testable;
        labelsAdd.add(input.testable ? t.yesLabel : t.noLabel);
        labelsRemove.add(input.testable ? t.noLabel : t.yesLabel);
      }
    }
    if (has('addLabels')) (input.addLabels || []).forEach((l) => labelsAdd.add(l));

    if (!current) {
      if (labelsAdd.size) fields.labels = [...labelsAdd].map((l) => String(l).replace(/\s+/g, '-'));
    } else if (labelsAdd.size || labelsRemove.size) {
      update.labels = [
        ...[...labelsAdd].map((l) => ({ add: String(l).replace(/\s+/g, '-') })),
        ...[...labelsRemove].map((l) => ({ remove: l })),
      ];
    }
    return { fields, update };
  }

  fieldLabel(id) {
    const m = Object.entries(this.f).find(([, v]) => v && v.id === id);
    return m ? m[1].name : id;
  }

  /**
   * POST/PUT that survives "Field X cannot be set. It is not on the appropriate screen" errors:
   * offending optional fields are dropped and reported back as warnings instead of failing the whole save.
   */
  async writeTolerant(method, path, fields, update, extra = {}) {
    const protectedKeys = new Set(['project', 'issuetype', 'summary']);
    const dropped = {};
    const warnings = [];
    for (let attempt = 0; attempt < 5; attempt++) {
      const body = { ...extra, fields };
      if (update && Object.keys(update).length) body.update = update;
      try {
        const res = await this.req(method, path, body);
        return { res, dropped, warnings };
      } catch (e) {
        const bad = Object.keys(e.fieldErrors || {}).filter((k) => !protectedKeys.has(k) && (k in fields || k in (update || {})));
        if (e.status !== 400 || !bad.length) throw e;
        for (const k of bad) {
          if (k in fields) { dropped[k] = fields[k]; delete fields[k]; }
          if (update && k in update) delete update[k];
          warnings.push(`${this.fieldLabel(k)}: ${e.fieldErrors[k]}`);
        }
      }
    }
    throw new Error('Could not save after removing rejected fields');
  }

  async unlinkEpic(key) {
    if (this.modes.epic === 'epicLink' && this.f.epicLink) {
      await this.req('PUT', `/rest/api/2/issue/${key}`, { fields: { [this.f.epicLink.id]: null } });
      return;
    }
    const variants = [null, { key: null }, { none: true }];
    let last;
    for (const v of variants) {
      try { await this.req('PUT', `/rest/api/2/issue/${key}`, { fields: { parent: v } }); return; } catch (e) { last = e; }
    }
    throw last;
  }

  async createIssue(input) {
    const { fields } = this.buildPayload(input, null);
    fields.project = { key: this.j.projectKey };
    fields.issuetype = { name: input.issueType || this.j.storyIssueType };
    if (!fields.description) delete fields.description;
    const { res, dropped, warnings } = await this.writeTolerant('POST', '/rest/api/2/issue', fields, null);
    const key = res.key;

    // Fields not on the Create screen are often on the Edit screen: retry them there.
    if (Object.keys(dropped).length) {
      try {
        const r2 = await this.writeTolerant('PUT', `/rest/api/2/issue/${key}`, { ...dropped }, null);
        warnings.length = 0; // only report fields that failed on both screens
        warnings.push(...r2.warnings);
      } catch (e) { warnings.push(e.message); }
    }
    if (input.sprintId) {
      try { await this.moveToSprint([key], input.sprintId); } catch (e) { warnings.push(`Sprint: ${e.message}`); }
    }
    return { issue: await this.getIssue(key), warnings };
  }

  async updateIssue(key, input) {
    const needCurrent = this.modes.ac === 'description' && ('description' in input || 'acceptanceCriteria' in input);
    const current = needCurrent ? await this.getIssue(key) : { description: '', acceptanceCriteria: [] };
    const { fields, update } = this.buildPayload(input, current);
    const warnings = [];
    if (Object.keys(fields).length || Object.keys(update).length) {
      const r = await this.writeTolerant('PUT', `/rest/api/2/issue/${encodeURIComponent(key)}`, fields, update);
      warnings.push(...r.warnings);
    }
    if ('epicKey' in input && !input.epicKey) {
      try { await this.unlinkEpic(key); } catch (e) { warnings.push(`Could not remove epic: ${e.message}`); }
    }
    if ('sprintId' in input) await this.moveToSprint([key], input.sprintId || null);
    return { issue: await this.getIssue(key), warnings };
  }

  async moveToSprint(keys, sprintId) {
    for (let i = 0; i < keys.length; i += 50) {
      const issues = keys.slice(i, i + 50);
      if (sprintId) await this.req('POST', `/rest/agile/1.0/sprint/${sprintId}/issue`, { issues });
      else await this.req('POST', '/rest/agile/1.0/backlog/issue', { issues });
    }
  }

  async addComment(key, body) {
    await this.req('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/comment`, { body });
  }

  async cloneIssue(key, overrides) {
    const src = await this.getIssue(key);
    const input = {
      summary: src.summary,
      description: src.description,
      acceptanceCriteria: src.acceptanceCriteria,
      points: src.points,
      epicKey: src.epicKey,
      testable: src.testable,
      labels: src.labels.filter((l) => l !== this.j.spilloverLabel),
      issueType: src.issueType,
      ...overrides,
    };
    const created = await this.createIssue(input);
    try {
      await this.req('POST', '/rest/api/2/issueLink', {
        type: { name: 'Cloners' },
        inwardIssue: { key: src.key },
        outwardIssue: { key: created.issue.key },
      });
    } catch (e) {
      created.warnings.push(`Clone link not added: ${e.message}`);
    }
    return created;
  }

  async spillover({ keys, toSprintId, fromSprintName, label, comment }) {
    await this.moveToSprint(keys, toSprintId);
    const warnings = [];
    for (const k of keys) {
      try {
        if (label) await this.req('PUT', `/rest/api/2/issue/${k}`, { update: { labels: [{ add: label }] } });
        if (comment) await this.addComment(k, comment.replace('{from}', fromSprintName || 'previous sprint'));
      } catch (e) { warnings.push(`${k}: ${e.message}`); }
    }
    return { moved: keys.length, warnings };
  }

  async getTransitions(key) {
    const r = await this.req('GET', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`);
    return (r.transitions || []).map((t) => ({ id: t.id, name: t.name, to: t.to ? t.to.name : t.name, category: t.to && t.to.statusCategory ? CAT[t.to.statusCategory.key] : '' }));
  }

  async transition(key, id) {
    await this.req('POST', `/rest/api/2/issue/${encodeURIComponent(key)}/transitions`, { transition: { id } });
    return { issue: await this.getIssue(key), warnings: [] };
  }

  async createEpic({ summary, description }) {
    const fields = {
      project: { key: this.j.projectKey },
      issuetype: { name: this.j.epicIssueType },
      summary,
      description: description || '',
    };
    if (this.f.epicName) fields[this.f.epicName.id] = summary.slice(0, 250);
    const { res, warnings } = await this.writeTolerant('POST', '/rest/api/2/issue', fields, null);
    return { epic: { key: res.key, summary, status: '', url: `${this.j.baseUrl}/browse/${res.key}` }, warnings };
  }
}

module.exports = { JiraAdapter, JiraError };
