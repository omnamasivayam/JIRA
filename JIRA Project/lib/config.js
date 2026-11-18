'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

const DEFAULTS = {
  mode: 'mock',
  port: 4300,
  jira: {
    deployment: 'cloud',
    baseUrl: '',
    email: '',
    apiToken: '',
    authType: 'auto',
    projectKey: '',
    boardId: 0,
    storyIssueType: 'Story',
    epicIssueType: 'Epic',
    fields: { storyPoints: 'auto', sprint: 'auto', epicLink: 'auto', acceptanceCriteria: 'auto', testable: 'auto' },
    epicLinkStyle: 'auto',
    acceptanceCriteriaMode: 'auto',
    testable: { mode: 'auto', yesValue: 'Yes', noValue: 'No', yesLabel: 'testable', noLabel: 'not-testable' },
    spilloverLabel: 'spillover',
    storyJql: '',
    maxResults: 500,
  },
  ai: { enabled: false, apiKey: '', model: 'claude-opus-5-5' },
  pointScale: [1, 2, 3, 5, 8, 13, 21],
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over === undefined ? base : over;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (k.startsWith('_')) continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object'
      ? deepMerge(base[k], v)
      : v;
  }
  return out;
}

const isPlaceholder = (v) => typeof v === 'string' && /<[^>]+>/.test(v);

function loadConfig(argv = process.argv) {
  const file = process.env.SPRINTPILOT_CONFIG ? path.resolve(process.env.SPRINTPILOT_CONFIG) : path.join(ROOT, 'config.json');
  let user = {};
  let source = 'defaults (no config.json found)';
  if (fs.existsSync(file)) {
    user = JSON.parse(fs.readFileSync(file, 'utf8'));
    source = file;
  }
  const cfg = deepMerge(DEFAULTS, user);

  // Environment overrides (keep secrets out of files if you prefer)
  const env = process.env;
  if (env.JIRA_BASE_URL) cfg.jira.baseUrl = env.JIRA_BASE_URL;
  if (env.JIRA_EMAIL) cfg.jira.email = env.JIRA_EMAIL;
  if (env.JIRA_API_TOKEN) cfg.jira.apiToken = env.JIRA_API_TOKEN;
  if (env.JIRA_PROJECT_KEY) cfg.jira.projectKey = env.JIRA_PROJECT_KEY;
  if (env.JIRA_BOARD_ID) cfg.jira.boardId = Number(env.JIRA_BOARD_ID);
  if (env.ANTHROPIC_API_KEY && !cfg.ai.apiKey) cfg.ai.apiKey = env.ANTHROPIC_API_KEY;
  if (env.PORT) cfg.port = Number(env.PORT);

  if (argv.includes('--demo') || env.SPRINTPILOT_DEMO === '1') cfg.mode = 'mock';

  cfg.jira.baseUrl = String(cfg.jira.baseUrl || '').replace(/\/+$/, '');
  cfg.jira.deployment = String(cfg.jira.deployment || 'cloud').toLowerCase() === 'cloud' ? 'cloud' : 'server';

  const problems = [];
  if (cfg.mode === 'jira') {
    const j = cfg.jira;
    if (!j.baseUrl || isPlaceholder(j.baseUrl)) problems.push('jira.baseUrl is not set');
    if (!j.apiToken || isPlaceholder(j.apiToken)) problems.push('jira.apiToken is not set (or JIRA_API_TOKEN env var)');
    if (j.deployment === 'cloud' && (!j.email || isPlaceholder(j.email))) problems.push('jira.email is required for Jira Cloud');
    if (!j.projectKey || isPlaceholder(j.projectKey)) problems.push('jira.projectKey is not set');
    if (!j.boardId) problems.push('jira.boardId is not set (open your board; it is the number in ...?rapidView=123 or /boards/123)');
  }
  return { cfg, source, problems };
}

module.exports = { loadConfig, ROOT };
