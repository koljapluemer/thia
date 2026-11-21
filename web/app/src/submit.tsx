import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import type { Repo } from '@gestalts/client';
import type { Item } from '@gestalts/view';
import { stringify } from 'yaml';
import { toBase64 } from './make-viz/viz';
import { AreaLink } from './router';
import * as api from './teach/api';

/** What the sender agrees to: the licence everything on the public site is under (web/server, promote.rs). */
const LICENCE = 'CC BY-SA 4.0';

/**
 * A draft's ymls and the blobs they use, as the server takes them. Which strings are blob names isn't known here
 * (that's the gestalts'), so every string that names a blob in this repo goes along; the server keeps the ones used.
 */
export async function snapshotOf(repo: Repo, items: Item[]): Promise<Pick<api.Upload, 'ymls' | 'blobs'>> {
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

const STATUS = { pending: 'waiting for review', accepted: 'accepted', rejected: 'not accepted' } as const;

/**
 * Offering a workshop's draft for the public site: what it is, how to credit its maker, and that they may share it.
 * Every workshop has one; it needs a teacher account (the person who grants the rights), and shows what became of
 * earlier submissions of the same draft.
 */
export function SubmitMenu({ source, send, ready = true }: { source: string; send: (offer: api.Offer) => Promise<api.Submission>; ready?: boolean }) {
  const [past, setPast] = useState<api.Submission[] | null>();
  const [about, setAbout] = useState('');
  const [credit, setCredit] = useState('');
  const [rights, setRights] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [signedOut, setSignedOut] = useState(false);
  useEffect(() => {
    api.submissionsOf(source).then(setPast, (e: unknown) => { setPast(null); if (e instanceof api.ApiError && e.status === 401) setSignedOut(true); });
  }, [source]);
  const submit = async () => {
    setBusy(true);
    setProblems([]);
    try {
      const s = await send({ about, credit: credit || undefined, rights });
      setPast((p) => [s, ...(p ?? [])]);
      setAbout('');
      setRights(false);
    } catch (e) {
      if (e instanceof api.ApiError && e.status === 401) setSignedOut(true);
      setProblems(e instanceof api.ApiError && e.problems.length ? e.problems : [e instanceof Error ? e.message : String(e)]);
    } finally { setBusy(false); }
  };
  const last = past?.[0];
  return (
    <details className="dropdown dropdown-end">
      <summary className="btn btn-sm btn-ghost" title="Offer it for the public site"><Globe className="size-4" /> Public site</summary>
      <div className="dropdown-content z-50 mt-2 flex w-96 max-w-[90vw] flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow">
        <p>Offer this for the public site, where anyone can use it for free. It’s reviewed first, and may be changed.</p>
        {signedOut && <p className="text-warning">Submitting needs an account: <AreaLink path="/teach" className="link">sign in at the teacher portal</AreaLink> first.</p>}
        {last && (
          <p className="text-base-content/70">
            Sent {new Date(last.created).toLocaleDateString()}: {STATUS[last.status]}.
            {last.note && <span className="block italic">“{last.note}”</span>}
          </p>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-content/70">What it is, for someone looking for it</span>
          <textarea className="textarea textarea-sm" rows={3} value={about} onChange={(e) => setAbout(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-content/70">Credit it to (optional, shown with it)</span>
          <input className="input input-sm" value={credit} onChange={(e) => setCredit(e.target.value)} />
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={rights} onChange={(e) => setRights(e.target.checked)} />
          <span>I made this, or may share it, and agree that it’s published under {LICENCE}.</span>
        </label>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !ready || !rights || !about.trim()} onClick={() => void submit()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : last ? 'Submit this version' : 'Submit'}
        </button>
        {!ready && <p className="text-xs text-base-content/60">Build it first.</p>}
        {problems.length > 0 && (
          <div role="alert" className="text-error">
            <p>It wasn’t sent:</p>
            <ul className="list-disc pl-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}
