import { useEffect, useState } from 'react';
import { registry } from 'virtual:gestalts-plugins/workshop';
import { useOpenRepo, type Repo } from '@gestalts/client';
import type { Item } from '@gestalts/view';
import { VIEWS, asDraft, loadMembers, packageOf } from '@gestalts/workshop';
import { stringify } from 'yaml';
import * as api from './api';
import { VIZ, toBase64 } from './viz/viz';

/**
 * Drafts the workshops kept in this browser before they moved to accounts: the learning workshop's views and the
 * vizint workshop's vizzes, in the `drafts` folder of the `learning-workshop` distribution (whose id stays as long as
 * anyone may still have one). Offered once to move to the account; what's here stays as it was.
 */
const ASKED = 'workshop:moved';
const OLD = { dir: 'drafts', gestalts: registry.gestalts };
const LIMIT = 500;

const asked = () => { try { return localStorage.getItem(ASKED) !== null; } catch { return true; } };
const remember = (answer: string) => { try { localStorage.setItem(ASKED, answer); } catch { /* asked again next time */ } };

/**
 * Ymls as sync writes them, and the blobs they use. Which strings are blob names isn't known here (that's the
 * gestalts'), so every string that names a blob in this repo goes along; the server keeps what it's sent.
 */
async function snapshotOf(repo: Repo, items: Item[]): Promise<api.Snapshot> {
  const names = new Set<string>();
  const walk = (v: unknown) => {
    if (typeof v === 'string') { if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(v) && v.includes('.')) names.add(v); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  items.forEach((i) => walk(i.value));
  const blobs: Record<string, string> = {};
  for (const n of names) {
    const bytes = await repo.readBlob(n).catch(() => undefined);
    if (bytes) blobs[n] = toBase64(bytes);
  }
  return { ymls: items.map((i) => ({ id: i.id, text: stringify({ ...i.value, id: i.id, gestalt: i.gestalt }) })), blobs };
}

/** One local draft into the account, with its id and package. */
async function move(repo: Repo, item: Item): Promise<void> {
  const title = String(item.value.title ?? '').trim() || item.id;
  if (item.gestalt === VIZ) {
    await api.moveDraft(title, 'viz', { id: item.id, package: packageOf(item.id) });
    await api.writeDraft(item.id, await snapshotOf(repo, [item]));
    return;
  }
  const draft = asDraft(item);
  await api.moveDraft(title, 'view', { id: item.id, package: draft.package });
  // definitions first, so what follows is judged by them
  const members = (await loadMembers(repo, draft)).sort((a, b) => Number(b.gestalt === 'gestalt@1') - Number(a.gestalt === 'gestalt@1'));
  await api.writeDraft(item.id, await snapshotOf(repo, [...members, item]));
}

/** Asks once whether to move the drafts this browser kept, if it kept any. */
export function MoveOffer({ onMoved }: { onMoved: () => void }) {
  const [open] = useState(() => !asked());
  return open ? <Offer onMoved={onMoved} /> : null;
}

function Offer({ onMoved }: { onMoved: () => void }) {
  const { repo, error } = useOpenRepo(OLD);
  const [items, setItems] = useState<Item[]>();
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!repo) return;
    let live = true;
    void (async () => {
      await repo.firstSync.catch(() => undefined);
      const [views, vizzes] = await Promise.all([repo.query({ gestalt: VIEWS, limit: LIMIT }), repo.query({ gestalt: VIZ, limit: LIMIT })]);
      const found = [...views.items, ...vizzes.items];
      if (!found.length) remember('nothing');
      if (live) setItems(found);
    })();
    return () => { live = false; };
  }, [repo]);
  if (error || done || !items?.length || !repo) return null;
  const go = async () => {
    setBusy(true);
    const failed: string[] = [];
    for (const item of items) {
      try { await move(repo, item); } catch (e) {
        // moved before: it's in the list already
        if (e instanceof api.ApiError && e.status === 409) continue;
        const why = e instanceof api.ApiError && e.problems.length ? e.problems.join('; ') : e instanceof Error ? e.message : String(e);
        failed.push(`${String(item.value.title ?? item.id)}: ${why}`);
      }
    }
    remember('moved');
    setBusy(false);
    setProblems(failed);
    if (!failed.length) setDone(true);
    onMoved();
  };
  const no = () => { remember('declined'); setDone(true); };
  return (
    <div role="status" className="alert m-2 flex flex-wrap items-center gap-2">
      {problems.length
        ? (
          <div className="flex-1 text-sm">
            <p>Moved, except:</p>
            <ul className="list-disc pl-5 text-error">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
            <p className="text-xs text-base-content/60">They stay in this browser.</p>
          </div>
        )
        : (
          <span className="flex-1 text-sm">
            This browser keeps {items.length} {items.length === 1 ? 'draft' : 'drafts'} from the workshops before they moved to accounts. Move {items.length === 1 ? 'it' : 'them'} to your account?
            <span className="block text-xs text-base-content/60">They stay here too. You’re asked once.</span>
          </span>
        )}
      {problems.length
        ? <button type="button" className="btn btn-sm" onClick={() => setDone(true)}>OK</button>
        : (
          <>
            <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void go()}>{busy ? <span className="loading loading-spinner loading-xs" /> : 'Move'}</button>
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={no}>No</button>
          </>
        )}
    </div>
  );
}
