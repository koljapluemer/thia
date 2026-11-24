import { useEffect, useState } from 'react';
import { Clock, FolderUp, Plus, Trash2 } from 'lucide-react';
import { Modal, NoteEditor, NoteTitle, newId } from '@gestalts/kit';
import { t, useQuery, useRead, useViewState, useWrite } from '@gestalts/view';

const TEXT = 'inbox/text@1';
const NOTE = 'note@1';
const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/**
 * Bringing in a folder's files (only those directly in it), each as an `inbox/text@1`. A file that isn't UTF-8 text,
 * or is empty, is skipped. One already here (same name, same content) is left as it is, with the notes made from it.
 */
function Upload({ onClose }: { onClose: () => void }) {
  const write = useWrite();
  const read = useRead();
  const [progress, setProgress] = useState<{ done: number; of: number }>();
  const [result, setResult] = useState<{ added: number; there: number; skipped: string[] }>();
  const busy = !!progress;

  const upload = async (list: FileList | null) => {
    // a folder's own files are `folder/name`; deeper ones have more slashes
    const files = Array.from(list ?? []).filter((f) => !f.webkitRelativePath || f.webkitRelativePath.split('/').length === 2);
    setResult(undefined);
    setProgress({ done: 0, of: files.length });
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const out = { added: 0, there: 0, skipped: [] as string[] };
    // reading and naming them all at once: only the writes go one after another
    const named = await Promise.all(files.map(async (f) => {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        let text: string;
        try { text = decoder.decode(bytes); } catch { out.skipped.push(t('not_text', { name: f.name })); return null; }
        if (!text.trim()) { out.skipped.push(t('empty_file', { name: f.name })); return null; }
        return { id: await write.stableId('inbox-text', `${f.name}\n${await write.contentHash(bytes)}`), name: f.name, text };
      } catch (e) {
        out.skipped.push(`${f.name}: ${message(e)}`);
        return null;
      }
    }));
    const fresh = named.filter((x) => x !== null);
    const here = new Set<string>();
    for (let i = 0; i < fresh.length; i += 500) {
      const ids = fresh.slice(i, i + 500).map((x) => x.id);
      for (const it of (await read.page({ gestalt: TEXT, ids, limit: ids.length, fields: ['name'] })).items) here.add(it.id);
    }
    out.there = fresh.filter((x) => here.has(x.id)).length;
    const todo = fresh.filter((x) => !here.has(x.id));
    let done = files.length - todo.length;
    setProgress({ done, of: files.length });
    for (const x of todo) {
      try {
        await write.put({ id: x.id, gestalt: TEXT, name: x.name, text: x.text });
        out.added++;
      } catch (e) {
        out.skipped.push(`${x.name}: ${message(e)}`);
      }
      setProgress({ done: ++done, of: files.length });
    }
    setResult(out);
    setProgress(undefined);
  };

  return (
    <Modal onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <h2 className="font-semibold">{t('upload_title')}</h2>
        <p className="text-base-content/70">{t('upload_about')}</p>
        <input type="file" multiple className="file-input w-full" disabled={busy}
               ref={(el) => el?.setAttribute('webkitdirectory', '')} onChange={(e) => void upload(e.target.files)} />
        {progress && (
          <div className="flex items-center gap-3" role="status">
            <progress className="progress flex-1" value={progress.done} max={progress.of || 1} />
            <span className="whitespace-nowrap">{t('progress', { done: progress.done, of: progress.of })}</span>
          </div>
        )}
        {result && (
          <p role="status" className="text-success">
            {result.there ? t('added_there', { added: result.added, there: result.there }) : t('added', { added: result.added })}
          </p>
        )}
        {result && result.skipped.length > 0 && (
          <div role="alert" className="alert alert-warning flex-col items-start gap-1">
            <span>{t('skipped')}</span>
            <ul>{result.skipped.map((s) => <li key={s}>{s}</li>)}</ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** The notes made from an upload, to open again; the one in the editor marked. */
function MadeNotes({ ids, open, onOpen }: { ids: string[]; open: string; onOpen: (id: string) => void }) {
  const { items } = useQuery(ids.length ? { gestalt: NOTE, ids, fields: ['title', 'main'], limit: ids.length } : null);
  if (!items.length) return null;
  return (
    <section className="border-t border-base-300 p-3">
      <h3 className="mb-1 font-semibold">{t('from_file')}</h3>
      <ul className="menu w-full p-0">
        {items.map((n) => (
          <li key={n.id}>
            <button type="button" className={n.id === open ? 'menu-active' : ''} onClick={() => onOpen(n.id)}>
              <NoteTitle value={n.value} className="truncate" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One uploaded file at a time, at random, beside the note editor: write as many notes from it as it holds, then delete
 * it, or defer it. The notes written are listed with the file (its `notes`), to open again.
 */
export default function NoteInbox() {
  const write = useWrite();
  const read = useRead();
  const [seed, setSeed] = useViewState<number>('seed', newSeed());
  const [current, setCurrent] = useViewState<string | null>('current', null);
  // the file just deferred or deleted, not to be drawn again right away
  const [skip, setSkip] = useState<string | null>(null);
  // deleted here: never drawn, even while a query still has it
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set());
  const [noteId, setNoteId] = useViewState<string>('note', newId());
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string>();

  // two at random, so one can be other than the one just left
  const drawn = useQuery({ gestalt: TEXT, order: { seed }, limit: 2, fields: ['name'], count: true });
  const shown = useQuery(current ? { gestalt: TEXT, ids: [current], limit: 1 } : null);
  const file = shown.items[0];

  useEffect(() => {
    // gone (deleted here or elsewhere): draw the next
    if (current && !shown.loading && !file) setCurrent(null);
  }, [current, shown.loading, file, setCurrent]);
  useEffect(() => {
    if (current || drawn.loading) return;
    const left = drawn.items.filter((i) => !removed.has(i.id));
    const next = left.find((i) => i.id !== skip) ?? left[0];
    if (next) setCurrent(next.id);
  }, [current, drawn.loading, drawn.items, skip, removed, setCurrent]);

  const leave = (id: string) => {
    setSkip(id);
    setCurrent(null);
    setSeed(newSeed());
    setNoteId(newId());
  };
  const remove = async (id: string) => {
    try { await write.remove(id); setRemoved((r) => new Set([...r, id])); leave(id); } catch (e) { setError(message(e)); }
  };
  /** A note written from `upload` is listed with it. */
  const madeFrom = (upload: string) => async (note: string) => {
    try {
      const latest = (await read.page({ gestalt: TEXT, ids: [upload], limit: 1 })).items[0];
      if (!latest) return;
      const notes = strings(latest.value.notes);
      if (!notes.includes(note)) await write.put({ ...latest.value, notes: [...notes, note] });
    } catch (e) { setError(message(e)); }
  };

  const uploadButton = (
    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setUploading(true)}><FolderUp className="size-4" /> {t('upload')}</button>
  );
  const empty = !current && !drawn.loading && !drawn.items.some((i) => !removed.has(i.id));

  return (
    <div className="flex h-full min-h-0 flex-col bg-base-100">
      <div className="flex items-center gap-2 border-b border-base-300 p-2">
        <span className="min-w-0 flex-1 truncate font-semibold">{file ? String(file.value.name) : ''}</span>
        {drawn.total !== undefined && <span className="whitespace-nowrap text-base-content/60" title={t('left_title')}>{t('left', { n: drawn.total })}</span>}
        {uploadButton}
      </div>
      {error && <div role="alert" className="alert alert-error m-2 whitespace-pre-wrap">{error}</div>}
      {empty ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-base-content/60">
          <p>{t('inbox_empty')}</p>
          {uploadButton}
        </div>
      ) : file && (
        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-2 md:overflow-hidden">
          <div className="flex min-h-0 flex-col border-base-300 md:border-e">
            <div className="flex gap-2 border-b border-base-300 p-2">
              <button type="button" className="btn btn-sm" title={t('defer_title')} onClick={() => leave(file.id)}><Clock className="size-4" /> {t('defer')}</button>
              <button type="button" className="btn btn-sm btn-ghost" title={t('delete_title')} onClick={() => void remove(file.id)}><Trash2 className="size-4" /> {t('delete')}</button>
            </div>
            <pre className="min-h-0 flex-1 overflow-y-auto p-3 font-sans whitespace-pre-wrap">{String(file.value.text ?? '')}</pre>
            <MadeNotes ids={strings(file.value.notes)} open={noteId} onOpen={setNoteId} />
          </div>
          <div className="flex min-h-0 flex-col">
            <div className="flex justify-end border-b border-base-300 p-2">
              <button type="button" className="btn btn-sm btn-primary" title={t('save_new_title')} onClick={() => setNoteId(newId())}>
                <Plus className="size-4" /> {t('save_new')}
              </button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NoteEditor key={noteId} id={noteId} onCreated={madeFrom(file.id)} autoFocus />
            </div>
          </div>
        </div>
      )}
      {uploading && <Upload onClose={() => setUploading(false)} />}
    </div>
  );
}
