import { useState } from 'react';
import { RefreshCw, UserRound, Wrench } from 'lucide-react';
import { RepoProvider } from '@gestalts/client';
import { ConnectorSettings } from '@gestalts/host';
import { LangPicker, useLang } from '@gestalts/i18n';
import { HOME_NODE, useGuest, useHome, usePersonalSyncStatus } from './home';

/** The make app (web/app): the workshop, behind an account. The same origin when deployed. */
export const MAKE: string = import.meta.env.VITE_MAKE ?? '/workshop';

/** While a guest uses this device: that it's theirs for now, and ending it. */
export function GuestBanner() {
  const { m } = useLang();
  const { guest, endGuest } = useGuest();
  if (!guest) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-warning px-3 py-1 text-sm text-warning-content">
      <UserRound className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{m.guest_banner()}</span>
      <button type="button" className="btn btn-xs" onClick={endGuest}>{m.guest_end()}</button>
    </div>
  );
}

/** Syncing the store with a node (the desktop app's folder), if the user wants that: opens the store when asked. */
function SyncSettings() {
  const { m } = useLang();
  const { home } = useHome();
  if (home.error) return <p className="w-72 text-sm text-error">{m.data_failed_because({ error: home.error })}</p>;
  if (!home.repo) return <span className="loading loading-spinner loading-sm" />;
  return <RepoProvider repo={home.repo}><ConnectorSettings defaultUrl={HOME_NODE} /></RepoProvider>;
}

/** Guest mode, sync, the language and the workshop, from every page's header. */
export function Toolbar() {
  const { m } = useLang();
  const { guest, startGuest } = useGuest();
  const syncStatus = usePersonalSyncStatus();
  // the store opens only once sync is asked about
  const [syncOpen, setSyncOpen] = useState(false);
  const guestAsk = () => {
    if (confirm(m.guest_confirm())) startGuest();
  };
  return (
    <div className="flex items-center gap-1">
      {!guest && <button type="button" className="btn btn-sm" title={syncStatus} onClick={() => window.dispatchEvent(new Event('thia:open-account'))}>Sync my progress</button>}
      {!guest && (
        <button type="button" className="btn btn-sm btn-ghost btn-square" title={m.guest_start()} aria-label={m.guest_start()} onClick={guestAsk}>
          <UserRound className="size-4" />
        </button>
      )}
      <details className="dropdown dropdown-end" onToggle={(e) => { if (e.currentTarget.open) setSyncOpen(true); }}>
        <summary className="btn btn-sm btn-ghost btn-square" title={m.sync_title()} aria-label={m.sync_title()}><RefreshCw className="size-4" /></summary>
        <div className="dropdown-content z-50 mt-2 rounded-box border border-base-300 bg-base-100 p-3 shadow">{syncOpen && <SyncSettings />}</div>
      </details>
      <LangPicker />
      <a href={MAKE} className="btn btn-sm btn-ghost btn-square" title={m.workshop_title()} aria-label={m.workshop_title()}><Wrench className="size-4" /></a>
    </div>
  );
}
