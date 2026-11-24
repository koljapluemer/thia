import { useEffect, useState } from 'react';
import { Globe } from 'lucide-react';
import { useLang, type Messages } from '@gestalts/i18n';
import * as api from './api';

/** What the sender agrees to: the licence everything on the public site is under (web/server, promote.rs). */
const LICENCE = 'CC BY-SA 4.0';

const STATUS = (m: Messages, status: api.Submission['status'], date: string) => ({ pending: m.submit_pending, accepted: m.submit_accepted, rejected: m.submit_rejected })[status]({ date });

/**
 * Offering a draft for the public site: what it is, how to credit its maker, and that they may share it (the
 * account's owner grants the rights). Shows what became of earlier submissions of the same draft.
 */
export function SubmitMenu({ source, send, ready = true }: { source: string; send: (offer: api.Offer) => Promise<api.Submission>; ready?: boolean }) {
  const { m, lang } = useLang();
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
      <summary className="btn btn-sm btn-ghost" title={m.submit_title()}><Globe className="size-4" /> {m.submit_menu()}</summary>
      <div className="dropdown-content z-50 mt-2 flex w-96 max-w-[90vw] flex-col gap-2 rounded-box border border-base-300 bg-base-100 p-3 text-sm shadow">
        <p>{m.submit_about()}</p>
        {signedOut && <p className="text-warning">{m.signed_out()}</p>}
        {last && (
          <p className="text-base-content/70">
            {STATUS(m, last.status, new Date(last.created).toLocaleDateString(lang))}
            {last.note && <span className="block italic">{m.quoted({ text: last.note })}</span>}
          </p>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-content/70">{m.submit_what()}</span>
          <textarea className="textarea textarea-sm" rows={3} value={about} onChange={(e) => setAbout(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-base-content/70">{m.submit_credit()}</span>
          <input className="input input-sm" value={credit} onChange={(e) => setCredit(e.target.value)} />
        </label>
        <label className="flex items-start gap-2">
          <input type="checkbox" className="checkbox checkbox-sm mt-0.5" checked={rights} onChange={(e) => setRights(e.target.checked)} />
          <span>{m.submit_rights({ licence: LICENCE })}</span>
        </label>
        <button type="button" className="btn btn-sm btn-primary" disabled={busy || !ready || !rights || !about.trim()} onClick={() => void submit()}>
          {busy ? <span className="loading loading-spinner loading-xs" /> : last ? m.submit_again() : m.submit()}
        </button>
        {!ready && <p className="text-xs text-base-content/60">{m.build_first()}</p>}
        {problems.length > 0 && (
          <div role="alert" className="text-error">
            <p>{m.not_sent()}</p>
            <ul className="list-disc ps-5">{problems.map((x) => <li key={x}>{x}</li>)}</ul>
          </div>
        )}
      </div>
    </details>
  );
}
