'use strict';
/**
 * Story drafting / rewriting.
 *  - If ai.enabled is true, an API key is set, and the optional "@anthropic-ai/sdk" package is installed,
 *    stories are written by Claude.
 *  - Otherwise (or if the call fails) the offline generator in storyText.js is used, so the app always works.
 */
const T = require('./storyText');

let AnthropicCtor = null;
let sdkError = null;
try {
  const mod = require('@anthropic-ai/sdk');
  AnthropicCtor = mod.default || mod.Anthropic || mod;
} catch (e) {
  sdkError = 'Package @anthropic-ai/sdk is not installed (run: npm install @anthropic-ai/sdk)';
}

const STORY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stories'],
  properties: {
    stories: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'description', 'acceptanceCriteria', 'points', 'testable', 'labels', 'epicKey'],
        properties: {
          summary: { type: 'string', description: 'Short imperative title, max ~90 chars' },
          description: { type: 'string', description: 'User-story format ("As a ..., I want ..., so that ...") followed by short context/notes. Plain text.' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: '3-6 testable criteria, Given/When/Then style, one per item' },
          points: { type: 'integer', description: 'Suggested story points, must be one of the allowed scale values' },
          testable: { type: 'boolean', description: 'false for spikes/research/documentation-only work' },
          labels: { type: 'array', items: { type: 'string' }, description: '0-3 lowercase labels, no spaces' },
          epicKey: { type: 'string', description: 'Key of the best-matching epic from the list given, or empty string if none fits' },
        },
      },
    },
  },
};

class StoryAI {
  constructor(aiCfg, pointScale) {
    this.cfg = aiCfg || {};
    this.pointScale = pointScale;
    this.client = null;
    this.status = 'offline generator';
    if (this.cfg.enabled) {
      if (!AnthropicCtor) this.status = `offline generator (${sdkError})`;
      else if (!this.cfg.apiKey) this.status = 'offline generator (ai.apiKey / ANTHROPIC_API_KEY not set)';
      else {
        this.client = new AnthropicCtor({ apiKey: this.cfg.apiKey });
        this.status = `Claude (${this.cfg.model})`;
      }
    }
  }

  get enabled() { return !!this.client; }

  async _ask(system, user) {
    const params = {
      model: this.cfg.model || 'claude-opus-5-5',
      max_tokens: 16000,
      system,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: STORY_SCHEMA } },
      messages: [{ role: 'user', content: user }],
    };
    let res;
    try {
      // Server-side refusal fallback (routes to another model if the main one declines).
      res = await this.client.beta.messages.create({
        ...params,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
      });
    } catch (e) {
      if (e && e.status === 400) res = await this.client.messages.create(params); // e.g. model/account without fallbacks
      else throw e;
    }
    if (res.stop_reason === 'refusal') throw new Error('The model declined this request');
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return JSON.parse(text);
  }

  _fixPoints(p) {
    const s = this.pointScale;
    if (!Number.isFinite(p)) return null;
    return s.reduce((best, v) => (Math.abs(v - p) < Math.abs(best - p) ? v : best), s[0]);
  }

  /** text -> [{summary, description, acceptanceCriteria[], points, testable, labels[], epicKey}] */
  async draft(text, { epics = [] } = {}) {
    const sheet = T.parseSpreadsheet(text);
    if (sheet) {
      return {
        engine: 'spreadsheet paste',
        stories: sheet.map((r) => {
          const base = T.draftStoryFromText(`${r.summary}. ${r.description}`, { epics, pointScale: this.pointScale });
          const epic = r.epicText
            ? (epics.find((e) => e.key.toLowerCase() === r.epicText.toLowerCase() || e.summary.toLowerCase() === r.epicText.toLowerCase()) || {}).key || T.suggestEpic(r.epicText, epics)
            : base.epicKey;
          return {
            ...base,
            summary: r.summary,
            description: r.description || base.description,
            acceptanceCriteria: r.acceptanceCriteria.length ? r.acceptanceCriteria : base.acceptanceCriteria,
            points: r.points ? this._fixPoints(r.points) : base.points,
            testable: r.testable === null ? base.testable : r.testable,
            epicKey: epic || '',
            assigneeText: r.assigneeText,
          };
        }),
      };
    }

    const offline = () => ({
      engine: 'offline generator',
      stories: T.splitIntoChunks(text).map((c) => T.draftStoryFromText(c, { epics, pointScale: this.pointScale })),
    });
    if (!this.enabled) return offline();

    const epicList = epics.length ? epics.map((e) => `${e.key}: ${e.summary}`).join('\n') : '(none)';
    const system = [
      'You are an experienced agile product owner who writes crisp, testable Jira user stories for a scrum team.',
      'Split the notes into one story per distinct piece of user-visible value; do not invent scope that is not implied.',
      `Story points must be one of: ${this.pointScale.join(', ')}. Use relative complexity, not hours.`,
      'Acceptance criteria are concrete and verifiable by a tester, written as Given/When/Then.',
      'Mark testable=false only for spikes, research, or documentation-only work.',
    ].join(' ');
    const user = `Existing epics (pick the best epicKey, or "" if none fits):\n${epicList}\n\nNotes from the team:\n"""\n${text}\n"""`;
    try {
      const out = await this._ask(system, user);
      const keys = new Set(epics.map((e) => e.key));
      return {
        engine: this.status,
        stories: (out.stories || []).map((s) => ({
          ...s,
          points: this._fixPoints(s.points),
          epicKey: keys.has(s.epicKey) ? s.epicKey : '',
        })),
      };
    } catch (e) {
      const r = offline();
      r.warning = `AI unavailable (${e.message}); used offline generator`;
      return r;
    }
  }

  /** Rewrite a story for a clone. instruction: free text like "for the Android app" */
  async rewrite(story, instruction, { epics = [] } = {}) {
    if (!this.enabled) {
      return { engine: 'offline generator', story: T.rewriteOffline(story, instruction) };
    }
    const system = 'You rewrite Jira user stories. Keep the same structure and level of detail, apply the requested change everywhere it matters (title, description, acceptance criteria), and keep it testable. Return exactly one story.';
    const user = `Change requested: ${instruction || 'Rewrite this as a fresh, clearer story for a new iteration.'}\n\nOriginal story:\nTitle: ${story.summary}\nDescription:\n${story.description || ''}\nAcceptance criteria:\n${(story.acceptanceCriteria || []).map((a) => `- ${a}`).join('\n')}\nPoints: ${story.points ?? 'unsized'}\nEpic: ${story.epicKey || ''}\n\nEpics:\n${epics.map((e) => `${e.key}: ${e.summary}`).join('\n') || '(none)'}`;
    try {
      const out = await this._ask(system, user);
      const s = (out.stories || [])[0];
      if (!s) throw new Error('empty response');
      return { engine: this.status, story: { ...story, ...s, points: this._fixPoints(s.points) ?? story.points, epicKey: s.epicKey || story.epicKey || '' } };
    } catch (e) {
      return { engine: 'offline generator', warning: `AI unavailable (${e.message})`, story: T.rewriteOffline(story, instruction) };
    }
  }
}

module.exports = { StoryAI };
