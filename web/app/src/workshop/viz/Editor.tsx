import { useEffect, useRef, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import type { Repo } from '@gestalts/client';
import { VIZ, asViz, saveViz, storeBlob, type Viz } from '@gestalts/workshop';

type Texts = Pick<Viz, 'title' | 'intro' | 'outro'>;
const textsOf = (v: Viz): Texts => ({ title: v.title, intro: v.intro, outro: v.outro });
const SAVE_AFTER_MS = 600;

/** The viz as it is now in the repo, so what's saved here keeps what a turn wrote meanwhile. */
async function fresh(repo: Repo, id: string): Promise<Viz> {
  const item = (await repo.query({ ids: [id], limit: 1 })).items.find((i) => i.gestalt === VIZ);
  if (!item) throw new Error(`${id} isn't here any more`);
  return asViz(item);
}

/**
 * What a viz has besides its brief and its source: its title, the texts before and after it, and the files its brief
 * can name. Saved as you type. Its brief is the shared one (`Brief`), its source the agent's.
 */
export function Editor({ repo, viz }: { repo: Repo; viz: Viz }) {
  const [texts, setTexts] = useState<Texts>(() => textsOf(viz));
  const pending = useRef<Texts | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const flush = async () => {
    clearTimeout(timer.current);
    const t = pending.current;
    pending.current = null;
    if (t) await saveViz(repo, { ...(await fresh(repo, viz.id)), ...t });
  };
  // what's typed and not saved yet is saved on leaving
  const flushOnLeave = useRef(flush);
  useEffect(() => { flushOnLeave.current = flush; });
  useEffect(() => () => { void flushOnLeave.current(); }, []);

  const edit = (k: keyof Texts, value: string) => {
    const next = { ...texts, [k]: value };
    setTexts(next);
    pending.current = next;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_AFTER_MS);
  };

  const addFiles = async (list: FileList | null) => {
    const added: { file: string; label: string }[] = [];
    for (const f of Array.from(list ?? [])) {
      const label = f.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '') || 'file';
      const ext = label.includes('.') ? label.split('.').pop()!.toLowerCase() : 'bin';
      added.push({ file: await storeBlob(repo, new Uint8Array(await f.arrayBuffer()), ext), label });
    }
    const v = await fresh(repo, viz.id);
    await saveViz(repo, { ...v, files: [...v.files.filter((x) => !added.some((a) => a.label === x.label)), ...added] });
  };
  const removeFile = async (label: string) => {
    const v = await fresh(repo, viz.id);
    await saveViz(repo, { ...v, files: v.files.filter((f) => f.label !== label) });
  };

  const field = 'textarea textarea-sm w-full font-mono';
  return (
    <details className="border-b border-base-300 px-3 py-2 text-sm">
      <summary className="cursor-pointer text-base-content/60">Title, texts and files</summary>
      <div className="mt-1 flex flex-col gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-base-content/60">Title</span>
          <input className="input input-sm w-full" value={texts.title} onChange={(e) => edit('title', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-base-content/60">Before it (Markdown)</span>
          <textarea className={field} rows={3} value={texts.intro} onChange={(e) => edit('intro', e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-base-content/60">After it (Markdown)</span>
          <textarea className={field} rows={3} value={texts.outro} onChange={(e) => edit('outro', e.target.value)} />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-base-content/60">Files the brief can name</span>
          <ul className="flex flex-wrap gap-1">
            {viz.files.map((f) => (
              <li key={f.label} className="badge badge-outline gap-1">
                {f.label}
                <button type="button" title={`Remove ${f.label}`} aria-label={`Remove ${f.label}`} onClick={() => void removeFile(f.label)}><X className="size-3" /></button>
              </li>
            ))}
          </ul>
          <label className="btn btn-xs btn-ghost self-start"><Paperclip className="size-3" />Add files
            <input type="file" multiple className="hidden" onChange={(e) => { void addFiles(e.target.files); e.target.value = ''; }} />
          </label>
        </div>
        {viz.packages.length > 0 && <p className="text-xs text-base-content/60">Packages: {viz.packages.join(', ')}</p>}
        {viz.generator && <p className="text-xs text-base-content/50">Last built by {viz.generator}.</p>}
      </div>
    </details>
  );
}
