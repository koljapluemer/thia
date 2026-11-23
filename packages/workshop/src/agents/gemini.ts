import { errorsFile } from './bridge';
import { contracts, systemOf } from './kinds';
import type { AgentTool, ToolResult } from './tools';
import type { AgentBackend, AgentEvent, Answers, CompleteRequest, Question, TurnRequest } from './types';

/**
 * Google's free Gemini models, on the person's own AI Studio key, asked from this page: no bridge and no server. The
 * loop is the Ollama bridge's (`installables/ollama-bridge/src/run.rs`) in TS: its file tools on the files the page
 * sends, the kind's page tools (`check`, `ask`) besides, until the model answers without a tool. The conversation is
 * kept in this page, so a reload forgets it and the next turn starts a new one.
 *
 * Free-tier quotas are per model (AI Studio rate-limit page, 2026-11-01: RPM / input TPM / RPD), so the models are
 * tried in order: each call goes to the first one not paused after a 429 (theadoc's `web-demo/server/models.ts`).
 * gemini-3.7-flash is left out: it counts against the gemini-3.8-flash quota.
 */
export const GEMINI_CHAIN = [
  'gemini-3.8-flash', // 5 / 250K / 20
  'gemini-3.6-flash', // 5 / 250K / 20
  'gemini-3.5-flash-lite', // 15 / 250K / 500
  'gemini-3.1-flash-lite', // 15 / 250K / 500
] as const;

/** 'minimal' is not supported by gemini-3.8-flash. */
const THINKING_LEVEL = 'low';
const API = 'https://generativelanguage.googleapis.com/v1beta/models';
export const GEMINI_KEY_PAGE = 'https://aistudio.google.com/apikey';
const MAX_ROUNDS = 40;
const MAX_FILE_BYTES = 512 * 1024;
/** what one tool result may hold: the free tier's 250K input tokens a minute are shared by every round */
const MAX_OUT = 30_000;
/** a pause up to this long is waited out; a longer one ends the turn */
const WAIT_MS = 60_000;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** what an overloaded model (503, 500) is left alone for */
const OVERLOAD_MS = 30_000;
/** Gemini's documented stand-in for a thought signature another model wrote */
const SKIP_SIGNATURE = 'skip_thought_signature_validator';

type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
  functionResponse?: { id?: string; name: string; response: Record<string, unknown> };
  inlineData?: { mimeType: string; data: string };
};
/** A turn of the conversation as Gemini takes it; `by`: the model that wrote it (not sent) */
type Content = { role: 'user' | 'model'; parts: Part[]; by?: string };

/** What the page may swap, for the tests. */
export type GeminiEnv = { fetch: typeof fetch; now: () => number; sleep: (ms: number, signal: AbortSignal) => Promise<void>; storage?: Pick<Storage, 'getItem' | 'setItem'> };

const browserEnv = (): GeminiEnv => ({
  fetch: (...a) => fetch(...a),
  now: () => Date.now(),
  sleep: (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal.addEventListener('abort', () => { clearTimeout(t); r(); }, { once: true }); }),
  storage: typeof localStorage === 'undefined' ? undefined : localStorage,
});

/**
 * How long to leave a model alone after it answered `status` with `body`, or null when that's no rate limit. Gemini's
 * 429 names the exhausted quota and a RetryInfo.retryDelay. A daily quota pauses for an hour, after which one cheap
 * request finds out whether it has reset.
 */
export function pauseMs(status: number, body: string): number | null {
  if (status === 503 || status === 500) return OVERLOAD_MS;
  if (status !== 429) return null;
  if (/PerDay|per day/i.test(body)) return HOUR_MS;
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  return Math.min(delay ? Math.ceil(Number(delay[1]) * 1000) : MINUTE_MS, HOUR_MS);
}

/** Which model is paused until when, kept by key in this browser, so a reload remembers a daily quota. */
class Pauses {
  private readonly key: string;
  private mem: Record<string, number> = {};
  constructor(apiKey: string, private readonly env: GeminiEnv) {
    // not the key itself: a short hash, enough to tell keys apart
    let h = 2166136261;
    for (const c of apiKey) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    this.key = `gemini:paused:${(h >>> 0).toString(36)}`;
  }
  private all(): Record<string, number> {
    try { return { ...this.mem, ...(JSON.parse(this.env.storage?.getItem(this.key) ?? '{}') as Record<string, number>) }; } catch { return this.mem; }
  }
  until(model: string): number { return this.all()[model] ?? 0; }
  pause(model: string, ms: number) {
    const next = { ...this.all(), [model]: this.env.now() + ms };
    this.mem = next;
    try { this.env.storage?.setItem(this.key, JSON.stringify(next)); } catch { /* for this visit only */ }
  }
  /** the first model not paused now, else when the first one is free again */
  pick(): { model: string } | { until: number } {
    const now = this.env.now();
    const free = GEMINI_CHAIN.find((m) => this.until(m) <= now);
    return free ? { model: free } : { until: Math.min(...GEMINI_CHAIN.map((m) => this.until(m))) };
  }
}

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const usedUp = (until: number) => `the free Gemini models are used up until ${clock(until)}: try again then, or switch on another agent in Settings`;

class GeminiError extends Error {}

type Reply = { parts: Part[]; finish?: string; model: string };

/**
 * One request, to the first model of the chain that isn't paused: a rate limit or an overload pauses that model and
 * the same request goes to the next. When all are paused, a short pause is waited out (`onWait`); a long one throws.
 */
async function generate(apiKey: string, pauses: Pauses, env: GeminiEnv, body: (model: string) => unknown, signal: AbortSignal, onWait?: (s: number) => void): Promise<Reply> {
  for (;;) {
    if (signal.aborted) throw new GeminiError('stopped');
    const picked = pauses.pick();
    if ('until' in picked) {
      const ms = picked.until - env.now();
      if (ms > WAIT_MS) throw new GeminiError(usedUp(picked.until));
      onWait?.(Math.ceil(ms / 1000));
      await env.sleep(ms, signal);
      continue;
    }
    const { model } = picked;
    let r: Response;
    try {
      r = await env.fetch(`${API}/${model}:generateContent`, {
        method: 'POST', signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body(model)),
      });
    } catch (e) {
      if (signal.aborted) throw new GeminiError('stopped');
      throw new GeminiError(`Gemini doesn't answer: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await r.text();
    if (!r.ok) {
      const pause = pauseMs(r.status, text);
      if (pause !== null) { pauses.pause(model, pause); continue; }
      let message = text;
      try { message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text; } catch { /* as it came */ }
      if (r.status === 400 && /API key/i.test(message) || r.status === 401 || r.status === 403) throw new GeminiError(`Gemini refused the key: ${message}`);
      throw new GeminiError(`Gemini (${model}) answered ${r.status}: ${message}`);
    }
    const v = JSON.parse(text) as { candidates?: { content?: { parts?: Part[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } };
    const c = v.candidates?.[0];
    if (!c) throw new GeminiError(`Gemini declined this request${v.promptFeedback?.blockReason ? ` (${v.promptFeedback.blockReason})` : ''}. Try putting it differently.`);
    return { parts: c.content?.parts ?? [], finish: c.finishReason, model };
  }
}

/** The conversation as `model` takes it: another model's thought signatures are swapped for the stand-in. */
function forModel(contents: Content[], model: string): Omit<Content, 'by'>[] {
  return contents.map(({ role, parts, by }) => ({
    role,
    parts: by === undefined || by === model ? parts : parts.map((p) => {
      const { thoughtSignature: _, ...rest } = p;
      return p.functionCall ? { ...rest, thoughtSignature: SKIP_SIGNATURE } : rest;
    }),
  }));
}

/** A relative path with plain parts (`run.rs` `safe_path`). */
const safePath = (p: string) => p.length > 0 && p.length <= 300 && !p.startsWith('/') && !/[\\:\0]/.test(p) && p.split('/').every((c) => c && c !== '.' && c !== '..');

/** The turn's files, and what of them is the draft: the file tools of `run.rs`'s `Workspace`. */
export class Workspace {
  constructor(public files: Record<string, string>, private readonly binary: Record<string, string>, private readonly keep: RegExp) {}

  draft(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.files).filter(([p]) => this.keep.test(p)));
  }

  /** What a file tool did, as its result text; throws what the model sees as the error. */
  run(name: string, input: Record<string, unknown>): string {
    const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : undefined);
    const need = (k: string) => { const v = s(k); if (v === undefined) throw new Error(`\`${k}\` is missing`); return v; };
    const paths = () => [...Object.keys(this.files), ...Object.keys(this.binary).map((p) => `${p} (binary, can't be read)`)];
    const tooLong = (p: string, t: string) => { if (new TextEncoder().encode(t).length > MAX_FILE_BYTES) throw new Error(`${p}: longer than ${MAX_FILE_BYTES} bytes`); };
    switch (name) {
      case 'list_files': {
        const scope = (s('path') ?? '').replace(/^\/+|\/+$/g, '');
        const all = paths().filter((f) => !scope || scope === '.' || f.startsWith(`${scope}/`));
        if (!all.length) throw new Error(`${scope}: no such folder here`);
        return all.join('\n');
      }
      case 'read_file': {
        const p = need('path');
        if (p in this.binary) throw new Error(`${p}: not text; it can't be read here`);
        if (!(p in this.files)) throw new Error(`${p}: no such file`);
        return this.files[p];
      }
      case 'write_file': {
        const p = need('path'); const content = need('content');
        if (!safePath(p) || !this.keep.test(p)) throw new Error(`${p}: only the draft's files can be written (paths matching ${this.keep.source})`);
        tooLong(p, content);
        this.files[p] = content;
        return `wrote ${p}`;
      }
      case 'edit_file': {
        const p = need('path'); const old = need('old_string'); const next = need('new_string');
        const all = input.replace_all === true;
        if (!this.keep.test(p)) throw new Error(`${p}: only the draft's files can be edited`);
        const text = this.files[p];
        if (text === undefined) throw new Error(`${p}: no such file in the draft`);
        const n = old ? text.split(old).length - 1 : 0;
        if (n === 0) throw new Error(`${p}: old_string isn't there; read the file again`);
        if (n > 1 && !all) throw new Error(`${p}: old_string is there ${n} times; give more context, or replace_all`);
        const edited = all ? text.split(old).join(next) : text.replace(old, () => next);
        tooLong(p, edited);
        this.files[p] = edited;
        return `edited ${p}`;
      }
      case 'delete_file': {
        const p = need('path');
        if (!(this.keep.test(p) && p.includes('/')) || !(p in this.files)) throw new Error(`${p}: only an existing file of the draft inside a folder can be deleted`);
        delete this.files[p];
        return `deleted ${p}`;
      }
      case 'search': {
        const text = need('text').toLowerCase();
        const scope = (s('path') ?? '').replace(/\/+$/, '');
        const hits: string[] = [];
        for (const [f, body] of Object.entries(this.files)) {
          if (scope && f !== scope && !f.startsWith(`${scope}/`)) continue;
          body.split('\n').forEach((line, i) => {
            if (hits.length < 60 && line.toLowerCase().includes(text)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`);
          });
        }
        return hits.length ? hits.join('\n') : 'nothing found';
      }
      default:
        throw new Error(`no tool ${name}`);
    }
  }
}

export const OWN_TOOLS = ['list_files', 'read_file', 'write_file', 'edit_file', 'delete_file', 'search'];

function ownTools(keep: string) {
  const path = { type: 'string', description: 'a path as list_files shows it, e.g. view.tsx' };
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });
  return [
    { name: 'list_files', description: 'Lists the files, or with `path` those in a folder.', parametersJsonSchema: obj({ path }) },
    { name: 'read_file', description: 'Reads a whole file.', parametersJsonSchema: obj({ path }, ['path']) },
    { name: 'write_file', description: `Writes a whole file of the draft (paths matching the regex ${keep}).`, parametersJsonSchema: obj({ path, content: { type: 'string' } }, ['path', 'content']) },
    { name: 'edit_file', description: 'Replaces `old_string` with `new_string` in a file of the draft. `old_string` must occur exactly once, unless `replace_all`.', parametersJsonSchema: obj({ path, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, ['path', 'old_string', 'new_string']) },
    { name: 'delete_file', description: 'Deletes a file of the draft that is inside a folder.', parametersJsonSchema: obj({ path }, ['path']) },
    { name: 'search', description: 'Finds lines containing `text` (case-insensitive) in the files; `path` limits it to a folder or file.', parametersJsonSchema: obj({ text: { type: 'string' }, path }, ['text']) },
  ];
}

/** What the model is told: the kind's system text, how the tools here work, and the contract (`run.rs` `system`). */
function systemText(system: string, keep: string, contract?: string): string {
  return [
    system.trim(),
    `There is no disk and no shell: you work on the files through tools. \`list_files\`, \`read_file\` and \`search\` see all of them; \`write_file\`, \`edit_file\` and \`delete_file\` change only the draft's files (paths matching the regex ${keep}). Read a file before you edit it. What you write is kept when you stop calling tools; then say in a few sentences what you did.`,
    contract?.trim(),
  ].filter(Boolean).join('\n\n');
}

function summary(name: string, input: Record<string, unknown>): string {
  if (name === 'search') return `“${String(input.text ?? '')}”`;
  if (name === 'check') return '';
  return typeof input.path === 'string' ? input.path : '';
}

function cut(s: string): string {
  return s.length > MAX_OUT ? `${s.slice(0, MAX_OUT)}\n… (cut at ${MAX_OUT} characters; \`search\` finds the lines you need)` : s;
}

/** What the turn changed of the draft, against what it started from. */
function changed(before: Record<string, string>, after: Record<string, string>, keep: RegExp): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const [p, t] of Object.entries(after)) if (keep.test(p) && before[p] !== t) out[p] = t;
  for (const p of Object.keys(before)) if (keep.test(p) && !(p in after)) out[p] = null;
  return out;
}

/** A page tool's result as a function response, and its images as parts beside it. */
function resultParts(call: NonNullable<Part['functionCall']>, r: ToolResult): Part[] {
  const text = cut(r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
  const images = r.content.flatMap((c) => (c.type === 'image' ? [{ inlineData: { mimeType: c.mimeType, data: c.data } }] : []));
  return [{ functionResponse: { id: call.id, name: call.name, response: r.isError ? { error: text } : { output: text } } }, ...images];
}

type Session = { contents: Content[]; files: Record<string, string> };

/** A page tool run, with its `ask` card shown while it waits: the card first, if it asks, then the result. */
async function* runPageTool(tool: AgentTool, input: unknown, files: Record<string, string>, signal: AbortSignal): AsyncGenerator<AgentEvent, ToolResult> {
  let shown: { questions: Question[]; reply: (a: Answers) => void } | undefined;
  let wake!: () => void;
  const asked = new Promise<void>((r) => { wake = r; });
  const stopped = new Promise<ToolResult>((r) => signal.addEventListener('abort', () => r({ content: [{ type: 'text', text: 'stopped' }], isError: true }), { once: true }));
  const result = tool.run(input, files, (questions, reply) => { shown = { questions, reply }; wake(); });
  const first = await Promise.race([result, asked.then(() => undefined), stopped]);
  if (first) return first;
  if (shown) yield { type: 'ask', id: `ask-${Math.random().toString(36).slice(2)}`, questions: shown.questions, reply: shown.reply };
  return await Promise.race([result, stopped]);
}

/** Gemini's free models on `apiKey`, from this page. */
export function geminiBackend(apiKey: string, env: GeminiEnv = browserEnv()): AgentBackend {
  const key = apiKey.trim();
  const pauses = new Pauses(key, env);
  const sessions = new Map<string, Session>();
  return {
    id: 'gemini',
    label: 'Gemini, free tier, on your key',
    async available() {
      if (!key) return 'add your Gemini API key in Settings';
      const picked = pauses.pick();
      if ('until' in picked && picked.until - env.now() > WAIT_MS) return usedUp(picked.until);
      return true;
    },
    async complete(req: CompleteRequest, signal: AbortSignal): Promise<string> {
      if (!key) throw new Error('add your Gemini API key in Settings');
      const r = await generate(key, pauses, env, () => ({
        systemInstruction: { parts: [{ text: req.system }] },
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: { thinkingConfig: { thinkingLevel: 'low' } },
      }), signal);
      return r.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    },
    async *turn(req: TurnRequest, signal: AbortSignal): AsyncIterable<AgentEvent> {
      if (!key) { yield { type: 'error', message: 'add your Gemini API key in Settings' }; return; }
      const kind = contracts[req.kind ?? 'view'];
      const keep = new RegExp(`^(?:${kind.keep})$`);
      const template = await kind.template();
      const start: Record<string, string> = { ...template.files, ...req.files };
      if (req.spec?.trim()) start['SPEC.md'] = `${req.spec.trim()}\n`;
      let prompt = req.message;
      if (req.diagnostics.length) {
        start['runtime-errors.md'] = errorsFile(req.diagnostics);
        prompt += `\n\n(The preview reported ${req.diagnostics.length} error(s) since the last turn: see runtime-errors.md.)`;
      }
      const earlier = req.session ? sessions.get(req.session) : undefined;
      const session = earlier && req.session ? req.session : crypto.randomUUID();
      const contents = earlier ? [...earlier.contents] : [];
      if (earlier) {
        const moved = Object.keys(changed(earlier.files, start, keep));
        if (moved.length) prompt = `(Changed outside this conversation since your last turn: ${moved.join(', ')}.)\n\n${prompt}`;
      } else {
        prompt += `\n\n(The draft's files now: ${Object.keys(req.files).join(', ') || 'none yet'}.)`;
      }
      contents.push({ role: 'user', parts: [{ text: prompt }] });

      const pageTools = kind.tools(req);
      const byName = new Map(pageTools.map((t) => [t.name, t]));
      const declarations = [...ownTools(kind.keep), ...pageTools.map((t) => ({ name: t.name, description: t.description, parametersJsonSchema: t.inputSchema }))];
      const system = systemText(systemOf(req.kind ?? 'view'), kind.keep, start['CLAUDE.md']);
      const binary = { ...template.binary, ...req.binary };
      const ws = new Workspace({ ...start }, binary, keep);
      const before = contents.length;
      let failed = false;

      try {
        for (let round = 0; ; round++) {
          if (round === MAX_ROUNDS) { yield { type: 'text', text: `(stopped after ${MAX_ROUNDS} rounds of tool calls)` }; break; }
          const waits: number[] = [];
          const reply = await generate(key, pauses, env, (model) => ({
            systemInstruction: { parts: [{ text: system }] },
            contents: forModel(contents, model),
            tools: [{ functionDeclarations: declarations }],
            generationConfig: { thinkingConfig: { thinkingLevel: THINKING_LEVEL } },
          }), signal, (s) => waits.push(s));
          for (const s of waits) yield { type: 'tool', name: 'waiting', summary: `for the free quota, ${s} s` };
          if (reply.finish === 'MAX_TOKENS') throw new GeminiError("The agent's answer got too long and was cut off. Ask for a smaller step.");
          if (reply.finish === 'MALFORMED_FUNCTION_CALL' && !reply.parts.length) {
            contents.push({ role: 'user', parts: [{ text: '(That function call was malformed. Call it again, with valid JSON arguments.)' }] });
            continue;
          }
          const text = reply.parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
          if (text) yield { type: 'text', text };
          if (reply.parts.length) contents.push({ role: 'model', parts: reply.parts, by: reply.model });
          const calls = reply.parts.flatMap((p) => (p.functionCall ? [p.functionCall] : []));
          if (!calls.length) break;
          const results: Part[] = [];
          for (const call of calls) {
            const input = call.args ?? {};
            if (call.name !== 'ask') yield { type: 'tool', name: call.name, summary: summary(call.name, input) };
            const tool = byName.get(call.name);
            let r: ToolResult;
            if (tool) {
              r = yield* runPageTool(tool, input, ws.draft(), signal);
            } else if (OWN_TOOLS.includes(call.name)) {
              try { r = { content: [{ type: 'text', text: ws.run(call.name, input) }] }; } catch (e) { r = { content: [{ type: 'text', text: e instanceof Error ? e.message : String(e) }], isError: true }; }
            } else {
              r = { content: [{ type: 'text', text: `no tool ${call.name}` }], isError: true };
            }
            results.push(...resultParts(call, r));
          }
          contents.push({ role: 'user', parts: results });
          if (signal.aborted) throw new GeminiError('stopped');
        }
      } catch (e) {
        failed = true;
        yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
      }
      // the files are the work: they come back whether or not the turn ended well
      const files = changed(start, ws.files, keep);
      if (Object.keys(files).length) yield { type: 'files', files };
      // after a failure, the conversation goes on from before this turn: what's left of it may not be a valid one
      sessions.set(session, { contents: failed ? contents.slice(0, before - 1) : contents, files: ws.files });
      yield { type: 'done', session };
    },
  };
}
