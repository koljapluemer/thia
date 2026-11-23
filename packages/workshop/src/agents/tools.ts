import type { CheckResult, Files } from '@gestalts/check';
import ask from '../../agent-template/ask.json';
import view from '../../agent-template/kinds/view.json';
import viz from '../../agent-template/kinds/viz.json';
import { toBase64 } from '../base64';
import type { AgentEvent, Answers, Question } from './types';

/**
 * What an agent may do besides thinking: the app's tools, the same whichever model runs the loop. The claude CLI gets
 * them through the bridge (each call comes back to the page). Reading and editing files are the loop's own: Claude
 * Code's in its workspace, the server's agent's over the files it holds.
 */
export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: ToolContent[]; isError?: boolean };

export type AgentTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** runs on the draft's files as they are now; `ask` hands the person a question while it runs */
  run(input: unknown, files: Record<string, string>, ask?: (questions: Question[], reply: (answers: Answers) => void) => void): Promise<ToolResult>;
};

const NO_INPUT = { type: 'object', properties: {}, additionalProperties: false };

/** A check's result as a tool's: the report, then each screenshot. Failing is an error, so the agent goes on. */
export function checkResult(r: CheckResult): ToolResult {
  return {
    content: [{ type: 'text', text: r.report }, ...r.shots.map((s) => ({ type: 'image' as const, data: toBase64(s.png), mimeType: 'image/png' }))],
    isError: !r.ok,
  };
}

const fail = (e: unknown): ToolResult => ({ content: [{ type: 'text', text: `the check couldn't run: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

/** The workshop's check of a draft view, in this page. `gestalts`: those the app has. */
export function viewCheckTool(gestalts: string[]): AgentTool {
  return {
    name: 'check',
    description: view.check,
    inputSchema: NO_INPUT,
    async run(_input, files) {
      try {
        const [{ checkView }, { browserPlatform }] = await Promise.all([import('@gestalts/check'), import('@gestalts/check/browser')]);
        return checkResult(await checkView(files, { gestalts }, browserPlatform));
      } catch (e) {
        return fail(e);
      }
    },
  };
}

/** A viz's check, in this page; `extra` are its `files/` (bytes), which the agent can't change. */
export function vizCheckTool(extra: Files): AgentTool {
  return {
    name: 'check',
    description: viz.check,
    inputSchema: NO_INPUT,
    async run(_input, files) {
      try {
        const [{ checkViz }, { browserPlatform }] = await Promise.all([import('@gestalts/check'), import('@gestalts/check/browser')]);
        return checkResult(await checkViz({ ...extra, ...files }, browserPlatform));
      } catch (e) {
        return fail(e);
      }
    },
  };
}

/** The questions of an `ask` call, or what's wrong with them (as the server checks them, `web/server/src/agent.rs`). */
export function questionsOf(input: unknown): Question[] | string {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs) || qs.length < 1 || qs.length > 4) return 'ask: one to four questions';
  for (const q of qs as Question[]) {
    if (!q?.question?.trim() || !q.header?.trim()) return 'ask: each question has `question` and `header`';
    if (!Array.isArray(q.options) || q.options.length < 2 || q.options.length > 4) return `ask: “${q.question}” needs two to four options`;
    if (q.options.some((o) => !o?.label?.trim())) return `ask: every option of “${q.question}” has a \`label\``;
  }
  return qs as Question[];
}

/** An answer as the agent reads it. */
export function answerText(answers: Answers): string {
  return ['They answered:', ...Object.entries(answers).map(([q, a]) => `- ${q} → ${a.trim() || '(no answer)'}`)].join('\n');
}

/**
 * Asking the person, for an agent whose run stays open meanwhile (the Claude bridge): the card is shown, and its
 * answer is the result. The server's agent has the same tool, and ends its turn on it instead.
 */
export function askTool(): AgentTool {
  return {
    name: ask.name,
    description: ask.description,
    inputSchema: ask.input_schema,
    run: (input, _files, show) => new Promise((resolve) => {
      const questions = questionsOf(input);
      if (typeof questions === 'string' || !show) {
        resolve({ content: [{ type: 'text', text: typeof questions === 'string' ? questions : 'ask: no one to ask here' }], isError: true });
        return;
      }
      show(questions, (answers) => resolve({ content: [{ type: 'text', text: answerText(answers) }] }));
    }),
  };
}

/** A tool's run, timed, and the `tool_result` it makes for the record. */
export async function timed(name: string, run: Promise<ToolResult>): Promise<{ result: ToolResult; event: AgentEvent }> {
  const t0 = performance.now();
  const result = await run;
  return { result, event: { type: 'tool_result', name, ok: !result.isError, ms: Math.round(performance.now() - t0), content: result.content } };
}
