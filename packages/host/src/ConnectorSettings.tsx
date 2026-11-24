import { useState } from 'react';
import { useConnector, useHostRepo } from '@gestalts/client';
import { useLang } from '@gestalts/i18n';

const DEFAULT_URL = 'http://127.0.0.1:7717';

/**
 * Connect to the desktop app (folder-sync, gestalts-node), which makes a folder on disk the source of truth. `defaultUrl` is the node it
 * offers (default the installed one's, `http://127.0.0.1:7717`).
 */
export function ConnectorSettings({ defaultUrl = DEFAULT_URL }: { defaultUrl?: string }) {
    const { m, lang } = useLang();
    const repo = useHostRepo();
    const status = useConnector();
    const [url, setUrl] = useState(status.url ?? defaultUrl);
    return (
      <div className="flex w-72 flex-col gap-2">
        <p className="text-sm text-base-content/70">{m.sync_about()}</p>
        <input className="input input-sm w-full" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!status.url} aria-label={m.sync_url()} />
        {status.url ? (
          <div className="flex gap-2">
            <button type="button" className="btn btn-sm flex-1" disabled={status.state === 'syncing'} onClick={() => void repo.sync()}>{m.sync_now()}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => repo.disconnect()}>{m.sync_disconnect()}</button>
          </div>
        ) : (
          <button type="button" className="btn btn-sm btn-primary" onClick={() => void repo.connect(url)}>{m.sync_connect()}</button>
        )}
        <p className="text-xs text-base-content/60">
          {status.state === 'off' && m.sync_off()}
          {status.state === 'syncing' && m.sync_syncing()}
          {status.state === 'ok' && (status.lastReport
            ? m.sync_report({ time: status.lastSync?.toLocaleTimeString(lang) ?? '', pulled: status.lastReport.pulled.length, pushed: status.lastReport.pushed.length })
            : m.sync_done({ time: status.lastSync?.toLocaleTimeString(lang) ?? '' }))}
          {status.folder && status.state !== 'error' && <code className="block truncate" title={status.folder}>{status.folder}</code>}
          {status.state === 'error' && <span className="text-error">{status.error}</span>}
        </p>
      </div>
    );
}

/** For badges: off, ok, syncing or error. */
export function useConnectorState() {
  return useConnector().state;
}
