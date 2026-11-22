import instructions from '../agent-template/plan-lesson.md?raw';
import type { AgentBackend } from './agents/types';

/**
 * How a lesson splits into views and visualizations, as an agent proposes it: whichever agent (`AgentBackend.complete`, one answer at low
 * effort), checked here the same for all. Nothing is made: taking it is the workshop's.
 */
export type Concept = { id: string; name: string };
export type PlannedRule = null | { skip_if_known: string } | { detour: { concept: string; title: string; brief: string } };
/** `kind`: a view (the default), or a visualization, which practises nothing and is played in the vizint view. */
export type PlannedStep = { kind: 'view' | 'viz'; title: string; does: string; brief: string; practises: Concept[]; rule: PlannedRule };
export type Plan = { one_view: string } | { title: string; steps: PlannedStep[] };

const CONCEPT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_STEPS = 6;

/**
 * What a view practises, said to the agent that builds it so the lesson's rules can see it: appended to every brief,
 * whatever the plan said.
 */
export function conceptsLine(cs: Concept[]): string {
  if (!cs.length) return '';
  const list = cs.map((c) => `\`${c.id}\` (${c.name})`).join(', ');
  return `\n\nIt is a step of a lesson of several views, and practises ${list}. Put each in data/ as \`data/<id>.yml\` with \`gestalt: concept@2\` and its \`name\`, name it in the \`concepts\` of the items that practise it, and log each answer with \`logPractice\`: the lesson skips or adds steps by what the student knows of them. When the student is through, call \`done()\` from \`useHost()\`.`;
}

const str = (v: unknown, what: string) => { if (typeof v !== 'string' || !v.trim()) throw new Error(`${what} is missing`); return v.trim(); };

/**
 * The plan in an agent's answer, checked: ids that can be ymls, at most one rule each, a rule only where an earlier
 * step practises its concept (a rule nothing can feed never applies: dropped, rather than kept to mislead). Each brief
 * gets what ties its view to the rules. Throws with what's wrong.
 */
export function checkPlan(answer: string): Plan {
  const from = answer.indexOf('{');
  const to = answer.lastIndexOf('}');
  if (from < 0 || to < from) throw new Error('no plan in the answer');
  const raw = JSON.parse(answer.slice(from, to + 1)) as Record<string, unknown>;
  if (typeof raw.one_view === 'string') return { one_view: raw.one_view.trim() };
  if (!Array.isArray(raw.steps) || !raw.steps.length || raw.steps.length > MAX_STEPS) throw new Error(`a plan has 1 to ${MAX_STEPS} steps`);
  const practised = new Set<string>();
  const steps = (raw.steps as Record<string, unknown>[]).map((s, i): PlannedStep => {
    const n = `step ${i + 1}`;
    // a viz practises nothing, whatever the plan says: no rule can depend on it
    const kind = s.kind === 'viz' ? 'viz' : 'view';
    const practises = (kind === 'viz' || !Array.isArray(s.practises) ? [] : s.practises).map((c: { id?: unknown; name?: unknown }) => {
      const id = str(c?.id, `${n}: a concept's id`);
      if (!CONCEPT_ID.test(id)) throw new Error(`${n}: ${id} isn't a concept id`);
      return { id, name: typeof c.name === 'string' && c.name.trim() ? c.name.trim() : id };
    });
    const r = s.rule as Record<string, unknown> | null | undefined;
    let rule: PlannedRule = null;
    if (r && typeof r.skip_if_known === 'string') rule = { skip_if_known: r.skip_if_known };
    else if (r && r.detour && typeof r.detour === 'object') {
      const d = r.detour as Record<string, unknown>;
      rule = { detour: { concept: str(d.concept, `${n}: its detour's concept`), title: str(d.title, `${n}: its detour's title`), brief: str(d.brief, `${n}: its detour's brief`) } };
    }
    const concept = rule && ('skip_if_known' in rule ? rule.skip_if_known : rule.detour.concept);
    if (concept && !practised.has(concept)) rule = null;
    practises.forEach((c) => practised.add(c.id));
    if (rule && 'detour' in rule) {
      const detour = rule.detour;
      const c = practises.find((x) => x.id === detour.concept) ?? { id: detour.concept, name: detour.concept };
      rule = { detour: { ...detour, brief: detour.brief + conceptsLine([c]) } };
    }
    return { kind, title: str(s.title, `${n}: its title`), does: typeof s.does === 'string' ? s.does.trim() : '', brief: str(s.brief, `${n}: its brief`) + conceptsLine(practises), practises, rule };
  });
  return { title: str(raw.title, 'the lesson\'s title'), steps };
}

/** The agent's plan for `request`, for the lesson draft `view`. Throws with a message for the teacher. */
export async function planLesson(backend: AgentBackend, view: string, request: string, signal: AbortSignal): Promise<Plan> {
  const answer = await backend.complete({ view, system: instructions, prompt: request.trim() }, signal);
  try {
    return checkPlan(answer);
  } catch (e) {
    throw new Error(`The agent's plan didn't come out right (${e instanceof Error ? e.message : String(e)}). Try again, or put the request differently.`);
  }
}
