'use strict';
/**
 * SprintPilot – local web app on top of Jira.
 *   node server.js          -> uses config.json (Jira mode)
 *   node server.js --demo   -> demo data, no Jira needed
 * No npm install required (Node 18+). Binds to 127.0.0.1 only: your Jira token never leaves this machine
 * except in calls to your own Jira.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig, ROOT } = require('./lib/config');
const { JiraAdapter } = require('./lib/jira');
const { MockAdapter } = require('./lib/mock');
const { StoryAI } = require('./lib/ai');

const { cfg, source, problems } = loadConfig();
if (problems.length) {
  console.error('\n  config.json needs attention:\n   - ' + problems.join('\n   - '));
  console.error('\n  Fix config.json (see README.md), or run "node server.js --demo" to try the app with sample data.\n');
  process.exit(1);
}

const adapter = cfg.mode === 'jira' ? new JiraAdapter(cfg) : new MockAdapter(cfg);
const ai = new StoryAI(cfg.ai, cfg.pointScale);
let info = null;

// Small cache for sprints/epics/users so drafting is quick.
let ctxCache = { at: 0, data: null };
async function context(force) {
  if (force || !ctxCache.data || Date.now() - ctxCache.at > 60_000) {
    ctxCache = { at: Date.now(), data: await adapter.getContext() };
  }
  return ctxCache.data;
}

// ---------- tiny router ----------
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler });
};

route('GET', '/api/bootstrap', async () => {
  const [ctx, issues] = await Promise.all([context(true), adapter.listIssues()]);
  // Merge in anyone who has issues assigned but wasn't returned as "assignable"
  const users = [...ctx.users];
  for (const i of issues) if (i.assignee && !users.some((u) => u.id === i.assignee.id)) users.push(i.assignee);
  return {
    mode: cfg.mode,
    info,
    ai: { enabled: ai.enabled, status: ai.status },
    pointScale: cfg.pointScale,
    spilloverLabel: cfg.jira.spilloverLabel,
    projectKey: cfg.mode === 'jira' ? cfg.jira.projectKey : 'DEMO',
    jiraBaseUrl: cfg.mode === 'jira' ? cfg.jira.baseUrl : '',
    ...ctx,
    users: users.sort((a, b) => a.name.localeCompare(b.name)),
    issues,
  };
});

route('GET', '/api/issues', async () => ({ issues: await adapter.listIssues() }));
route('GET', '/api/issues/:key', async ({ key }) => ({ issue: await adapter.getIssue(key) }));
route('POST', '/api/issues', async (_, body) => adapter.createIssue(body));

route('POST', '/api/issues/bulk', async (_, body) => {
  const results = [];
  for (const s of body.stories || []) {
    try {
      const r = await adapter.createIssue(s);
      results.push({ ok: true, issue: r.issue, warnings: r.warnings });
    } catch (e) {
      results.push({ ok: false, error: e.message, summary: s.summary });
    }
  }
  return { results };
});

route('PATCH', '/api/issues/:key', async ({ key }, body) => adapter.updateIssue(key, body));
route('POST', '/api/issues/:key/clone', async ({ key }, body) => adapter.cloneIssue(key, body || {}));
route('GET', '/api/issues/:key/transitions', async ({ key }) => ({ transitions: await adapter.getTransitions(key) }));
route('POST', '/api/issues/:key/transition', async ({ key }, body) => adapter.transition(key, body.id));

route('POST', '/api/move', async (_, body) => {
  await adapter.moveToSprint(body.keys || [], body.sprintId || null);
  return { ok: true };
});

route('POST', '/api/spillover', async (_, body) => adapter.spillover({
  keys: body.keys || [],
  toSprintId: body.toSprintId,
  fromSprintName: body.fromSprintName,
  label: body.label || '',
  comment: body.comment || '',
}));

route('POST', '/api/epics', async (_, body) => {
  const r = await adapter.createEpic(body);
  ctxCache.at = 0;
  return r;
});

route('POST', '/api/ai/draft', async (_, body) => {
  const ctx = await context();
  return ai.draft(String(body.text || ''), { epics: ctx.epics });
});

route('POST', '/api/ai/rewrite', async (_, body) => {
  const ctx = await context();
  return ai.rewrite(body.story || {}, String(body.instruction || ''), { epics: ctx.epics });
});

// ---------- static files ----------
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(PUBLIC, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5e6) reject(new Error('Body too large')); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('Invalid JSON body')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res);
  const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (!r) return send(404, { error: 'Unknown endpoint' });
  try {
    const m = r.re.exec(url.pathname);
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const body = req.method === 'GET' ? {} : await readBody(req);
    send(200, (await r.handler(params, body)) || { ok: true });
  } catch (e) {
    console.error(`[${req.method} ${url.pathname}]`, e.message);
    send(e.status && e.status < 600 ? e.status : 500, { error: e.message });
  }
});

(async () => {
  try {
    info = await adapter.init();
  } catch (e) {
    console.error(`\n  Could not connect to Jira: ${e.message}`);
    if (e.status === 401) console.error('  -> 401 means the email/token (Cloud) or PAT (Server/DC) is wrong or expired. See README "Getting a token".');
    if (e.status === 403) console.error('  -> 403: your account lacks permission, or CAPTCHA is triggered after failed logins (log in to Jira in the browser once).');
    if (/fetch failed|ENOTFOUND|ECONNREFUSED|certificate/i.test(String(e.message) + String(e.cause))) {
      console.error(`  -> Network problem${e.cause ? ' (' + e.cause.code + ')' : ''}. On VPN? Corporate proxy or self-signed certificate? See README "Troubleshooting".`);
    }
    process.exit(1);
  }
  if (process.argv.includes('--check')) {
    console.log('\n  Connection OK\n' + JSON.stringify(info, null, 2));
    const [ctx, issues] = await Promise.all([adapter.getContext(), adapter.listIssues()]);
    console.log(`\n  Sprints: ${ctx.sprints.map((s) => `${s.name} (${s.state})`).join(', ') || 'none'}`);
    console.log(`  Epics:   ${ctx.epics.length}   Users: ${ctx.users.length}   Stories loaded: ${issues.length}`);
    const s = issues[0];
    if (s) console.log(`  Sample:  ${s.key} "${s.summary}" points=${s.points} epic=${s.epicKey || '-'} sprint=${s.sprintName || '-'} testable=${s.testable}`);
    console.log('');
    process.exit(0);
  }
  server.listen(cfg.port, '127.0.0.1', () => {
    console.log(`\n  SprintPilot is running  ->  http://localhost:${cfg.port}`);
    console.log(`  Config:  ${source}`);
    console.log(`  Source:  ${info.jira}`);
    if (info.user) console.log(`  Signed in as: ${info.user}`);
    console.log(`  Board:   ${info.board}`);
    console.log('  Fields:  ' + Object.entries(info.fields).map(([k, v]) => `${k}=${v}`).join(' | '));
    console.log(`  Story drafting: ${ai.status}`);
    for (const n of info.notes) console.log(`  ! ${n}`);
    console.log('');
  });
})();
