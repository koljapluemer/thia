import { describe, expect, it } from 'vitest';
import { catalogHash, textHash, type Wording } from '@gestalts/view/wording';
import type { AgentBackend } from './agents/types';
import { checkTranslation, translateWording } from './translate';

const source: Wording = { lang: 'en', layer: 'source', messages: {
  next: { text: 'Next', description: 'goes on' },
  left: { text: '{n, plural, one {# card left} other {# cards left}}' },
  hi: { text: 'Hello {name}' },
} };

describe('a translation', () => {
  it('keeps what holds, signed, and names what does not', () => {
    const answer = 'Sure:\n{"next": "Weiter", "left": "{n, plural, one {noch # Karte} other {noch # Karten}}", "hi": "Hallo {nom}"}';
    const t = checkTranslation(answer, source, 'de');
    expect(t.wording).toEqual({ lang: 'de', layer: 'machine', catalog: catalogHash(source), messages: {
      next: { text: 'Weiter', source: textHash('Next') },
      left: { text: '{n, plural, one {noch # Karte} other {noch # Karten}}', source: textHash(source.messages.left.text) },
    } });
    expect(t.skipped).toEqual([{ key: 'hi', why: 'no {name}, {nom} added' }]);
  });

  it('is asked for once, through whichever agent', async () => {
    let asked = '';
    const backend = { id: 'fake', label: 'Fake', complete: async (r: { prompt: string }) => { asked = r.prompt; return '{"next": "Suivant", "left": "{n, plural, one {# carte} other {# cartes}}", "hi": "Bonjour {name}"}'; } } as unknown as AgentBackend;
    const t = await translateWording(backend, 'v', source, 'fr', [{ source: 'card', target: 'carte' }], new AbortController().signal);
    expect(JSON.parse(asked)).toMatchObject({ target: { tag: 'fr', name: 'French' }, glossary: [{ source: 'card', target: 'carte' }], messages: { next: { text: 'Next', description: 'goes on' } } });
    expect(Object.keys(t.wording.messages)).toEqual(['next', 'left', 'hi']);
    expect(t.skipped).toEqual([]);
  });
});
