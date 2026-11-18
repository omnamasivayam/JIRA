'use strict';
/**
 * Offline helpers: turn rough notes into well-formed stories without any AI service.
 * Used when AI is disabled, and as a fallback whenever the AI call fails.
 */

const STOP = new Set('a an the and or but to of for in on at by with from as is are be been it this that these those we i you they our your their should must can will would could need needs want wants so able allow allows also into via than then when if per its my me user users'.split(' '));

function words(s) {
  return String(s || '').toLowerCase().match(/[a-z0-9]+/g) || [];
}

function keywords(s) {
  return words(s).filter((w) => w.length > 2 && !STOP.has(w));
}

/** Split free text into one chunk per story: paragraphs, bullets, or numbered lines. */
function splitIntoChunks(text) {
  const src = String(text || '').replace(/\r/g, '').trim();
  if (!src) return [];
  const lines = src.split('\n');
  const bulletRe = /^\s*(?:[-*•]|\d+[.)])\s+/;
  const bulletCount = lines.filter((l) => bulletRe.test(l)).length;
  if (bulletCount >= 2) {
    const chunks = [];
    for (const l of lines) {
      if (bulletRe.test(l)) chunks.push(l.replace(bulletRe, ''));
      else if (l.trim() && chunks.length) chunks[chunks.length - 1] += ' ' + l.trim();
      else if (l.trim()) chunks.push(l.trim());
    }
    return chunks.map((c) => c.trim()).filter(Boolean);
  }
  return src.split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean);
}

function sentences(s) {
  return String(s).split(/(?<=[.!?])\s+|;\s+/).map((x) => x.trim().replace(/[.!?]+$/, '')).filter(Boolean);
}

function capitalize(s) {
  s = String(s || '').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s) {
  s = String(s || '').trim();
  if (!s) return s;
  if (/^[A-Z]{2,}/.test(s)) return s; // keep acronyms
  return s[0].toLowerCase() + s.slice(1);
}

function trimTo(s, n) {
  s = String(s).trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), n - 15)).replace(/[,;:\-\s]+$/, '') + '…';
}

function parseUserStory(text) {
  const m = /as an?\s+(.+?),?\s+i\s+(?:want|need|would like)\s+(?:to\s+)?(.+?)(?:,?\s+so\s+that\s+(.+?))?(?:[.!]|$)/i.exec(text);
  if (!m) return null;
  return { role: m[1].trim(), goal: m[2].trim(), benefit: (m[3] || '').trim() };
}

function guessRole(text) {
  const t = text.toLowerCase();
  const roles = ['admin', 'administrator', 'customer', 'manager', 'developer', 'tester', 'agent', 'operator', 'scrum master', 'team lead', 'product owner', 'support engineer', 'analyst'];
  const r = roles.find((x) => t.includes(x));
  return r || 'user';
}

function guessPoints(text, scale) {
  const t = text.toLowerCase();
  let score = 1;
  const n = words(t).length;
  if (n > 25) score++;
  if (n > 60) score++;
  const heavy = ['integrat', 'migrat', 'refactor', 'redesign', 'security', 'performance', 'sso', 'oauth', 'payment', 'sync', 'real-time', 'realtime', 'workflow', 'multiple', 'end-to-end', 'e2e', 'report', 'dashboard', 'api', 'database', 'schema', 'architecture'];
  score += heavy.filter((h) => t.includes(h)).length;
  const light = ['typo', 'label', 'text change', 'copy', 'colour', 'color', 'tooltip', 'rename', 'config'];
  if (light.some((l) => t.includes(l))) score -= 1;
  const ladder = scale && scale.length ? scale : [1, 2, 3, 5, 8, 13];
  const idx = Math.max(0, Math.min(ladder.length - 1, score));
  return ladder[idx];
}

function guessTestable(text) {
  return !/\b(spike|research|investigate|investigation|poc|proof of concept|documentation|knowledge transfer|kt session)\b/i.test(text);
}

function guessLabels(text) {
  const t = text.toLowerCase();
  const map = {
    frontend: ['ui', 'screen', 'page', 'button', 'frontend', 'front-end', 'css', 'layout', 'form'],
    backend: ['api', 'service', 'backend', 'back-end', 'database', 'endpoint', 'queue', 'job'],
    security: ['security', 'auth', 'login', 'permission', 'sso', 'oauth', 'role'],
    performance: ['performance', 'slow', 'latency', 'speed', 'cache'],
    reporting: ['report', 'dashboard', 'export', 'csv', 'chart'],
    spike: ['spike', 'research', 'investigate', 'poc'],
  };
  return Object.entries(map).filter(([, kws]) => kws.some((k) => new RegExp(`\\b${k}\\b`).test(t))).map(([l]) => l).slice(0, 3);
}

/** Pick the epic whose name shares the most meaningful words with the text. */
function suggestEpic(text, epics) {
  const kw = new Set(keywords(text));
  let best = null;
  let bestScore = 0;
  for (const e of epics || []) {
    const ek = keywords(e.summary);
    const score = ek.filter((w) => kw.has(w) || [...kw].some((k) => k.length > 4 && (k.startsWith(w) || w.startsWith(k)))).length / Math.max(1, Math.sqrt(ek.length));
    if (score > bestScore) { bestScore = score; best = e; }
  }
  return bestScore >= 0.5 ? best.key : '';
}

function makeSummary(text, us) {
  let base = us ? us.goal : sentences(text)[0] || text;
  base = base.replace(/^(we|i)\s+(need|want|would like)\s+(to\s+)?/i, '')
    .replace(/^(please|pls)\s+/i, '')
    .replace(/^(there should be|it should be possible to|should be able to|be able to|ability to)\s+/i, '')
    .replace(/^(?:the\s+|our\s+|all\s+)?[a-z][\w-]*(?:\s+[a-z][\w-]*){0,2}\s+(?:should|must|can|needs? to|wants? to)\s+(?:be able to\s+|be allowed to\s+)?/i, '');
  return capitalize(trimTo(base, 90));
}

const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');

function makeAcceptanceCriteria(text, us) {
  if (!guessTestable(text)) {
    return [
      'Options are compared on effort, cost, risk and fit',
      'A recommendation is documented and shared with the team',
      'Follow-up stories are created for the chosen approach',
    ];
  }
  const ac = [];
  const role = us ? us.role : guessRole(text);
  const sents = sentences(text).filter((s) => !/^as an?\s/i.test(s));
  for (const s of sents) {
    const when = /\b(?:when|if|once|after)\s+(.+?),\s*(?:then\s+)?(.+)/i.exec(s);
    if (when) {
      ac.push(`Given the feature is available, When ${lowerFirst(when[1])}, Then ${lowerFirst(when[2])}`);
      continue;
    }
    const able = /\b(?:should|must|can|will|needs? to)\s+(?:be able to|be allowed to)\s+(.+)/i.exec(s);
    if (able) {
      ac.push(`Given I am ${article(role)} ${role}, When I ${lowerFirst(able[1])}, Then it completes successfully and I see a confirmation`);
      continue;
    }
    const should = /(.+?)\b(should|must|will|needs? to)\b\s+(.+)/i.exec(s);
    if (should && ac.length < 6) {
      ac.push(`Given the change is released, Then ${lowerFirst(should[1].trim())} ${should[2].toLowerCase()} ${should[3].trim()}`.replace(/\s+/g, ' '));
    }
  }
  const goal = us ? us.goal : makeSummary(text).replace(/…$/, '');
  if (!ac.length) {
    ac.push(`Given I am ${article(role)} ${role}, When I ${lowerFirst(goal)}, Then I see the expected result without errors`);
  }
  ac.push('Given invalid or missing input, When I submit, Then a clear validation message is shown and nothing is saved');
  if (/\b(permission|role|admin|access|auth)\b/i.test(text)) {
    ac.push('Given I do not have the required permission, When I try this action, Then access is denied with a helpful message');
  }
  return [...new Set(ac)].slice(0, 6);
}

function draftStoryFromText(text, ctx = {}) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  const us = parseUserStory(clean);
  const summary = makeSummary(clean, us);
  const role = us ? us.role : guessRole(clean);
  const goal = us ? us.goal : lowerFirst(summary.replace(/…$/, ''));
  const benefit = us && us.benefit ? us.benefit : 'I can get my work done faster and with fewer errors';
  const testable = guessTestable(clean);
  const lines = testable
    ? [`As ${article(role)} ${role}, I want to ${goal.replace(/^to\s+/i, '')}, so that ${benefit}.`]
    : [`Time-boxed investigation: ${summary.replace(/^spike:\s*/i, '')}.`];
  // Keep the original notes as context unless they *were* the user story sentence.
  const rest = us ? clean.replace(/as an?\s+.+?,?\s+i\s+(?:want|need|would like).+?(?:[.!]|$)/i, '').trim() : clean;
  if (rest) lines.push('', 'Context:', rest);
  const description = lines.join('\n');
  return {
    summary,
    description,
    acceptanceCriteria: makeAcceptanceCriteria(clean, us),
    points: guessPoints(clean, ctx.pointScale),
    testable,
    labels: guessLabels(clean),
    epicKey: suggestEpic(clean, ctx.epics),
  };
}

/** Very small "rewrite" for clones when AI is off: applies a find→replace style instruction, or tidies text. */
function rewriteOffline(story, instruction = '') {
  const out = { ...story, acceptanceCriteria: [...(story.acceptanceCriteria || [])] };
  const m = /(?:replace|change|swap)\s+["']?(.+?)["']?\s+(?:with|to|→|->)\s+["']?(.+?)["']?\s*$/i.exec(instruction.trim());
  if (m) {
    const re = new RegExp(m[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out.summary = out.summary.replace(re, m[2]);
    out.description = (out.description || '').replace(re, m[2]);
    out.acceptanceCriteria = out.acceptanceCriteria.map((a) => a.replace(re, m[2]));
    return out;
  }
  const forM = /^(?:for|make it for|target|adapt (?:it )?(?:for|to))\s+(.+)$/i.exec(instruction.trim());
  if (forM) {
    const target = forM[1].replace(/^the\s+/i, '');
    out.summary = `${out.summary.replace(/\s*\(.*\)\s*$/, '')} (${target})`;
    out.description = `${out.description || ''}\n\nScope for this copy: ${target}.`.trim();
    return out;
  }
  if (instruction.trim()) {
    out.description = `${out.description || ''}\n\nNotes for this copy: ${instruction.trim()}`.trim();
  }
  return out;
}

// ---- Acceptance-criteria <-> Jira text ----
function parseAcText(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.replace(/^\s*(?:[*#-]+|\d+[.)]|\(\/\)|\[\s?[xX ]?\s?\])\s*/, '').trim())
    .filter(Boolean);
}

function acToText(list) {
  return (list || []).filter((x) => String(x).trim()).map((l) => `* ${String(l).trim()}`).join('\n');
}

const AC_HEADING_RE = /(?:^|\n)\s*(?:h\d\.\s*)?[*_]?\s*acceptance criteria\s*[*_]?\s*:?\s*(?:\n|$)/i;

function splitDescriptionAndAc(description) {
  const d = String(description || '');
  const m = AC_HEADING_RE.exec(d);
  if (!m) return { description: d.trim(), acceptanceCriteria: [] };
  return {
    description: d.slice(0, m.index).trim(),
    acceptanceCriteria: parseAcText(d.slice(m.index + m[0].length)),
  };
}

function joinDescriptionAndAc(description, ac) {
  const body = String(description || '').trim();
  if (!ac || !ac.length) return body;
  return `${body}\n\nh3. Acceptance Criteria\n${acToText(ac)}`.trim();
}

/** Parse rows pasted from Excel (tab separated, first row = headers). Returns null if not tabular. */
function parseSpreadsheet(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (lines.length < 2 || !lines[0].includes('\t')) return null;
  const headers = lines[0].split('\t').map((h) => h.trim().toLowerCase());
  const col = (...names) => headers.findIndex((h) => names.some((n) => h.includes(n)));
  const idx = {
    summary: col('summary', 'title', 'story', 'name'),
    description: col('description', 'details'),
    ac: col('acceptance', 'criteria', 'ac'),
    points: col('point', 'estimate', 'size', 'sp'),
    epic: col('epic'),
    testable: col('testable', 'test'),
    assignee: col('assignee', 'owner', 'developer'),
  };
  if (idx.summary < 0) return null;
  return lines.slice(1).map((l) => {
    const c = l.split('\t');
    const g = (i) => (i >= 0 ? (c[i] || '').trim() : '');
    return {
      summary: g(idx.summary),
      description: g(idx.description),
      acceptanceCriteria: g(idx.ac) ? g(idx.ac).split(/\s*(?:\|\||;|•)\s*/).filter(Boolean) : [],
      points: Number(g(idx.points)) || null,
      epicText: g(idx.epic),
      testable: g(idx.testable) ? /^(y|yes|true|1)/i.test(g(idx.testable)) : null,
      assigneeText: g(idx.assignee),
    };
  }).filter((r) => r.summary);
}

module.exports = {
  splitIntoChunks,
  draftStoryFromText,
  rewriteOffline,
  suggestEpic,
  guessPoints,
  guessTestable,
  parseAcText,
  acToText,
  splitDescriptionAndAc,
  joinDescriptionAndAc,
  parseSpreadsheet,
};
