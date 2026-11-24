import type { Belief, Item, JsonMap } from '@gestalts/view';

/**
 * A lesson of several views (`sequence@1`): steps in order, each a view and at most one rule, read top to bottom.
 * A rule names a concept, never another step, so steps stay independent and every view feeds the rules through what
 * it practises. The player and the workshop's play-through decide with the same functions.
 */
export const SEQUENCE = 'sequence@1';

export type Step = {
  /** the view: a draft's id in the workshop, an index into the lesson's views once published */
  view: string;
  /** skipped when this concept is known */
  skipIfKnown?: string;
  /** `view` is played first when the learner struggles with `concept` */
  detour?: { concept: string; view: string };
};
export type Sequence = { id: string; title: string; steps: Step[] };

/** Known, as the core counts a set's members known (`MasteryParams::known_p`). */
export const KNOWN_P = 0.8;
/** Struggling: practised, and more likely wrong than right. */
export const STRUGGLING_P = 0.5;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

export function asSequence(i: Item): Sequence {
  const steps = Array.isArray(i.value.steps) ? i.value.steps : [];
  return {
    id: i.id,
    title: String(i.value.title ?? ''),
    steps: steps.filter((s): s is JsonMap => !!s && typeof s === 'object' && !Array.isArray(s)).map((s) => {
      const d = s.detour && typeof s.detour === 'object' && !Array.isArray(s.detour) ? (s.detour as JsonMap) : undefined;
      const detour = d && str(d.concept) && str(d.view) ? { concept: str(d.concept)!, view: str(d.view)! } : undefined;
      return { view: String(s.view ?? ''), skipIfKnown: str(s.skip_if_known), detour };
    }),
  };
}

export function sequenceYml(s: Sequence): JsonMap {
  return {
    id: s.id, gestalt: SEQUENCE, title: s.title || 'Untitled',
    steps: s.steps.map((st) => {
      const out: JsonMap = { view: st.view };
      if (st.skipIfKnown) out.skip_if_known = st.skipIfKnown;
      else if (st.detour) out.detour = { concept: st.detour.concept, view: st.detour.view };
      return out;
    }),
  };
}

/** The concepts a sequence's rules ask about. */
export const ruleConcepts = (steps: Step[]) => [...new Set(steps.flatMap((s) => [s.skipIfKnown, s.detour?.concept].filter((c): c is string => !!c)))];

/**
 * What happens on arriving at a step: it's played, skipped (the `concept` is known), or a detour comes first (the
 * `concept` is struggled with). Saying why is the page's, in its language.
 */
export type Decision = { kind: 'play' } | { kind: 'skip'; concept: string } | { kind: 'detour'; view: string; concept: string };

/** The decision for `step`, by what's known now. A concept never practised is neither known nor struggled with. */
export function decide(step: Step, beliefOf: (concept: string) => Belief | undefined): Decision {
  if (step.skipIfKnown) {
    const b = beliefOf(step.skipIfKnown);
    if (b && b.evidence > 0 && b.p >= KNOWN_P) return { kind: 'skip', concept: step.skipIfKnown };
  } else if (step.detour) {
    const b = beliefOf(step.detour.concept);
    if (b && b.evidence > 0 && b.p < STRUGGLING_P) return { kind: 'detour', view: step.detour.view, concept: step.detour.concept };
  }
  return { kind: 'play' };
}

/** One entry of a walk through a sequence: what a learner meets at each step. */
export type Walked = { step: number; decision: Decision };

/**
 * A walk through the whole sequence for a pretend learner, whose beliefs stay as given: what they'd skip and what
 * they'd get extra. For the workshop's play-through; a real learner's beliefs change as they go.
 */
export const walk = (steps: Step[], beliefOf: (concept: string) => Belief | undefined): Walked[] => steps.map((s, step) => ({ step, decision: decide(s, beliefOf) }));
