/**
 * A model's translation of a view's text, made when its maker asks for a language (the workshop's Text tab), never by
 * a learner: one answer from whichever agent is picked (`AgentBackend.complete`), checked here the same for all. Every
 * message keeps its placeholders and parses; one that doesn't is left out and named, the rest kept. The result is the
 * language's `machine` layer, until a person reads it.
 */
import type { AgentBackend } from './agents/types';
import { recordedComplete } from './runs';
import { catalogHash, textHash, type Wording } from '@gestalts/view/wording';
import { messageProblem } from './wording';

/** A term the translation must use: a concept's name in the language, so every view says it alike. */
export type Term = { source: string; target: string };

const SYSTEM = `You translate the text of an app's screen for learners: buttons, headings, help, feedback.
You get JSON: the source language, the target language, an optional glossary, and the messages, each by key with its text and a description of where it shows.
Each text is an ICU MessageFormat message. Keep every placeholder exactly ({name}, {n, number}); in {x, plural, ...}, {x, selectordinal, ...} and {x, select, ...} keep the argument and the option keys (one, other, =0, ...) and translate only the text inside the options, adding or dropping plural categories as the target language needs (other must stay). Keep # where it is meant. Keep apostrophe quoting.
Use the glossary's terms. Match the register of the source (informal stays informal), and keep texts short: they sit on buttons and in small spaces.
Answer with JSON only: {"<key>": "<translated text>", ...}, every key once.`;

export type Translation = { wording: Wording; skipped: { key: string; why: string }[] };

/** `source` in `lang`, by the agent; throws when the answer isn't JSON at all. */
export async function translateWording(backend: AgentBackend, view: string, source: Wording, lang: string, glossary: Term[], signal: AbortSignal): Promise<Translation> {
  const name = (tag: string) => { try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(tag) ?? tag; } catch { return tag; } };
  const prompt = JSON.stringify({
    source: { tag: source.lang, name: name(source.lang) },
    target: { tag: lang, name: name(lang) },
    ...(glossary.length ? { glossary } : {}),
    messages: Object.fromEntries(Object.entries(source.messages).map(([k, e]) => [k, { text: e.text, ...(e.description ? { description: e.description } : {}) }])),
  }, null, 1);
  const answer = await recordedComplete(backend, { view, system: SYSTEM, prompt }, signal, 'translate');
  return checkTranslation(answer, source, lang);
}

/** The translation in an agent's answer, each message checked against its source. */
export function checkTranslation(answer: string, source: Wording, lang: string): Translation {
  const from = answer.indexOf('{');
  const to = answer.lastIndexOf('}');
  if (from < 0 || to < from) throw new Error('no translation in the answer');
  const raw = JSON.parse(answer.slice(from, to + 1)) as Record<string, unknown>;
  const messages: Wording['messages'] = {};
  const skipped: Translation['skipped'] = [];
  for (const [key, e] of Object.entries(source.messages)) {
    const text = raw[key];
    if (typeof text !== 'string' || !text.trim()) { skipped.push({ key, why: 'missing' }); continue; }
    const p = messageProblem(text, e.text);
    if (p) { skipped.push({ key, why: p.parse ?? [...p.missing.map((k) => `no {${k}}`), ...p.extra.map((k) => `{${k}} added`)].join(', ') }); continue; }
    messages[key] = { text, source: textHash(e.text) };
  }
  return { wording: { lang, layer: 'machine', catalog: catalogHash(source), messages }, skipped };
}
