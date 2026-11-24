import { useMemo, useState } from 'react';
import { useHostQuery, type Repo } from '@gestalts/client';
import { canonical, nameIn, useLang, type Messages } from '@gestalts/i18n';
import { WORDING, type Layer } from '@gestalts/view/wording';
import { dropEntry, keepEntry, markReviewed, messageProblem, putTranslation, rowsFor, setEntry, translateWording, wordingId, wordingsOf, type AgentBackend, type Draft, type MessageProblem, type Row, type WordingYml } from '@gestalts/workshop';

const layerName = (m: Messages, l: Layer) => ({ source: m.text_layer_source, machine: m.text_layer_machine, reviewed: m.text_layer_reviewed, override: m.text_layer_override })[l]();

const said = (m: Messages, p: MessageProblem) => (p.parse ? m.text_parse({ error: p.parse })
  : [p.missing.length ? m.text_missing({ list: p.missing.map((k) => `{${k}}`).join(' ') }) : '', p.extra.length ? m.text_extra({ list: p.extra.map((k) => `{${k}}`).join(' ') }) : ''].filter(Boolean).join(' '));

/**
 * The draft's own text, as its maker rewords and translates it (only here, never where it's used): key by key in one
 * language, the preview showing that language. In the view's own language a change is the maker's rewording (an
 * override, which the agent doesn't touch); in another it's that language's translation. What was written against an
 * earlier source text is shown stale, to keep or drop, and keys the agent dropped are listed, not lost.
 */
export function TextPane({ repo, draft, backend, lang, setLang, picked }: { repo: Repo; draft: Draft; backend: AgentBackend; lang: string; setLang: (l: string) => void; picked: string[] }) {
  const { m, lang: appLang } = useLang();
  const items = useHostQuery({ gestalt: WORDING, ids: draft.members, limit: 50 });
  const wordings = useMemo(() => wordingsOf(items), [items]);
  const { source, rows, gone, langs } = useMemo(() => rowsFor(wordings, lang), [wordings, lang]);
  const [adding, setAdding] = useState('');
  const [error, setError] = useState<string>();
  const [translating, setTranslating] = useState<AbortController>();
  const [skipped, setSkipped] = useState<string[]>([]);
  const run = (f: () => Promise<void>) => { setError(undefined); f().catch((e: unknown) => setError(m.text_not_saved({ error: e instanceof Error ? e.message : String(e) }))); };
  if (!source) return <p className="p-3 text-sm text-base-content/60">{m.text_none()}</p>;
  const shown = [...new Set([...langs, lang])];
  const machine = Object.keys(wordings.find((w) => w.id === wordingId(lang, 'machine'))?.wording.messages ?? {}).length > 0;
  const translate = async () => {
    const controller = new AbortController();
    setTranslating(controller);
    setError(undefined);
    setSkipped([]);
    try {
      const t = await translateWording(backend, draft.id, source, lang, [], controller.signal);
      await putTranslation(repo, draft, t.wording);
      setSkipped(t.skipped.map((s) => `${s.key} (${s.why})`));
    } catch (e) {
      if (!controller.signal.aborted) setError(m.text_translate_failed({ error: e instanceof Error ? e.message : String(e) }));
    } finally { setTranslating(undefined); }
  };
  const add = () => {
    const tag = canonical(adding);
    if (!tag) { setError(m.text_not_a_lang({ tag: adding })); return; }
    setAdding('');
    setLang(tag);
  };
  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <div className="flex flex-wrap items-center gap-2 border-b border-base-300 p-2">
        <select className="select select-sm w-auto" aria-label={m.text_lang()} value={lang} onChange={(e) => setLang(e.target.value)}>
          {shown.map((l) => <option key={l} value={l} lang={l}>{nameIn(l, appLang)}</option>)}
        </select>
        <input className="input input-sm w-44" placeholder={m.text_add_lang()} aria-label={m.text_add_lang()} value={adding}
               onChange={(e) => setAdding(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && adding.trim()) add(); }} />
        <button type="button" className="btn btn-sm" disabled={!adding.trim()} onClick={add}>{m.text_add()}</button>
      </div>
      {lang !== source.lang && (
        <div className="flex flex-col gap-1 border-b border-base-300 px-3 py-2">
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-sm" disabled={Boolean(translating)} onClick={() => void translate()}>
              {translating ? <><span className="loading loading-spinner loading-xs" /> {m.text_translating()}</> : m.text_translate({ language: nameIn(lang, appLang) })}
            </button>
            {translating && <button type="button" className="btn btn-ghost btn-sm" onClick={() => translating.abort()}>{m.stop()}</button>}
          </div>
          <p className="text-xs text-base-content/60">{m.text_translate_about({ agent: backend.label })}</p>
          {skipped.length > 0 && <p role="status" className="text-xs text-warning">{m.text_skipped({ list: skipped.join(', ') })}</p>}
        </div>
      )}
      {machine && (
        <div role="status" className="flex items-center gap-2 bg-info/10 px-3 py-1 text-xs">
          <span className="flex-1">{m.text_machine_note()}</span>
          <button type="button" className="btn btn-xs" onClick={() => run(() => markReviewed(repo, draft, wordings, lang))}>{m.text_mark_reviewed()}</button>
        </div>
      )}
      {error && <p role="alert" className="px-3 py-1 text-xs text-error">{error}</p>}
      <p className="px-3 pt-2 text-xs text-base-content/60">{m.text_pick_hint()}</p>
      <ul className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3">
        {rows.map((r) => (
          <TextRow key={`${lang}:${r.key}`} row={r} lang={lang} sourceLang={source.lang} picked={picked.includes(r.key)}
                   save={(text) => run(() => setEntry(repo, draft, wordings, lang, lang === source.lang ? 'override' : 'reviewed', r.key, text))}
                   keep={(layer) => { if (layer !== 'source') run(() => keepEntry(repo, wordings, wordingId(lang, layer), r.key)); }}
                   drop={(layer) => { if (layer !== 'source') run(() => dropEntry(repo, wordings, wordingId(lang, layer), r.key)); }} />
        ))}
        {gone.length > 0 && <Gone gone={gone} wordings={wordings} repo={repo} run={run} />}
      </ul>
    </div>
  );
}

function TextRow({ row: r, lang, sourceLang, picked, save, keep, drop }: {
  row: Row; lang: string; sourceLang: string; picked: boolean; save: (text: string | null) => void; keep: (l: Layer) => void; drop: (l: Layer) => void;
}) {
  const { m, lang: appLang } = useLang();
  const [text, setText] = useState(r.text);
  const problem = text === r.text ? undefined : messageProblem(text, r.source);
  const leave = () => {
    if (text === r.text || problem) return;
    // back to what it says anyway: nothing of the maker's needed
    save(lang === sourceLang && text === r.source ? null : text);
  };
  return (
    <li id={`text-${r.key}`} className={`flex flex-col gap-1 rounded-box p-2 ${picked ? 'bg-primary/10 ring-2 ring-primary' : ''}`}
        ref={(el) => { if (picked) el?.scrollIntoView({ block: 'nearest' }); }}>
      <div className="flex items-center gap-2">
        <code className="text-xs text-base-content/60">{r.key}</code>
        <span className="badge badge-ghost badge-xs">{layerName(m, r.from)}</span>
      </div>
      {r.description && <p className="text-xs text-base-content/60">{r.description}</p>}
      {lang !== sourceLang && <p lang={sourceLang} className="text-xs text-base-content/70">{m.text_source_in({ language: nameIn(sourceLang, appLang), text: r.source })}</p>}
      <textarea lang={lang} className={`textarea textarea-sm w-full ${problem ? 'textarea-error' : ''}`} rows={Math.max(1, Math.ceil(text.length / 48))} value={text}
                aria-label={r.key} onChange={(e) => setText(e.target.value)} onBlur={leave} />
      {problem && <p role="alert" className="text-xs text-error">{said(m, problem)}</p>}
      {r.from === 'override' && <button type="button" className="btn btn-ghost btn-xs self-start" onClick={() => drop('override')}>{m.text_revert()}</button>}
      {r.stale.map((s) => (
        <div key={s.layer} role="status" className="flex flex-wrap items-center gap-2 rounded-box bg-warning/10 p-1 text-xs">
          <span className="min-w-0 flex-1">{m.text_stale({ text: s.text })}</span>
          <button type="button" className="btn btn-xs" onClick={() => keep(s.layer)}>{m.text_keep()}</button>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => drop(s.layer)}>{m.text_drop()}</button>
        </div>
      ))}
    </li>
  );
}

function Gone({ gone, wordings, repo, run }: { gone: ReturnType<typeof rowsFor>['gone']; wordings: WordingYml[]; repo: Repo; run: (f: () => Promise<void>) => void }) {
  const { m } = useLang();
  return (
    <li className="flex flex-col gap-1 border-t border-base-300 pt-2">
      <h3 className="font-medium">{m.text_gone()}</h3>
      <p className="text-xs text-base-content/60">{m.text_gone_about()}</p>
      {gone.map((g) => (
        <div key={`${g.id}:${g.key}`} className="flex items-center gap-2 text-xs">
          <code className="text-base-content/60">{g.key}</code>
          <span lang={g.lang} className="min-w-0 flex-1 truncate">{g.text}</span>
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => run(() => dropEntry(repo, wordings, g.id, g.key))}>{m.text_drop()}</button>
        </div>
      ))}
    </li>
  );
}
