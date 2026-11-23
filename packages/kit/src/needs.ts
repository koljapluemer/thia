/**
 * What each part of the kit reads and writes (`@gestalts/view/needs`): a view using one declares these in its own
 * `reads` and `writes`, and the build and the checks refuse it otherwise. Reads are kept exact by
 * `packages/check/src/needs.test.ts`; writes are what the part's code puts, by hand.
 */
import type { Needs } from '@gestalts/view/needs';

const NOTE = 'note@1';
const SOURCE = 'source@1';
const CONCEPTS = ['concept@2', 'concept@3'];

export const NEEDS = {
  // a note's Markdown names linked notes by their titles
  Markdown: { reads: [NOTE] },
  NoteTitle: { reads: [NOTE] },
  NoteCard: { reads: [NOTE] },
  NotePicker: { reads: [NOTE] },
  NoteEditor: { reads: [NOTE, SOURCE, ...CONCEPTS], writes: [NOTE, SOURCE] },
  ConceptPicker: { reads: CONCEPTS, writes: ['concept@2'] },
  conceptNamed: { reads: CONCEPTS },
  Credits: { reads: [SOURCE] },
  SourceSearch: { reads: [SOURCE] },
  AddSource: { reads: [SOURCE], writes: [SOURCE] },
  BibtexPaste: { reads: [SOURCE], writes: [SOURCE] },
  ingestBibtex: { reads: [SOURCE], writes: [SOURCE] },
  freeKey: { reads: [SOURCE] },
  sourceCandidates: { reads: [SOURCE] },
} satisfies Needs;
