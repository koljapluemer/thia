/**
 * What each part of learning reads and writes (`@gestalts/view/needs`): a view using one declares these in its own
 * `reads` and `writes`, and the build and the checks refuse it otherwise. Reads are kept exact by
 * `packages/check/src/needs.test.ts`; writes are what the part's code puts, or makes to be put, by hand.
 */
import type { Needs } from '@gestalts/view/needs';

const FSRS = 'fsrs-data@1';
const SESSION = 'practice-session@1';
// `@2` only when given what `@1` can't hold: one of them is enough
const EVENTS = [['practice-event@1', 'practice-event@2']];

export const NEEDS = {
  fsrsDataValue: { reads: [FSRS], writes: [FSRS] },
  saveReview: { reads: [FSRS], writes: [FSRS] },
  PracticeSession: { reads: [SESSION], writes: [SESSION] },
  usePracticeSession: { reads: [SESSION], writes: [SESSION] },
  practiceEvent: { reads: EVENTS, writes: EVENTS },
  logPractice: { reads: EVENTS, writes: EVENTS },
} satisfies Needs;
