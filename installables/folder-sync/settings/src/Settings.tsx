import { useEffect, useState } from 'react';
import { useLang, type Messages } from '@gestalts/i18n';
import { node, type NodeStatus } from './control';

const STATE = (m: Messages): Record<string, string> => ({ stopped: m.node_state_stopped(), starting: m.node_state_starting(), ready: m.node_state_ready(), running: m.node_state_running(), error: m.node_state_error() });

/** The node's settings: the folder, the plugins' workers, start on login. Refreshed while shown. */
export function Settings() {
  const { m } = useLang();
  const [status, setStatus] = useState<NodeStatus>();
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    const poll = () => node.status().then((s) => { if (live) { setStatus(s); setGone(false); } }, () => { if (live) setGone(true); });
    void poll();
    const timer = setInterval(() => void poll(), 2000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  const act = (f: () => Promise<NodeStatus | void>) => {
    setError(undefined);
    f().then((s) => { if (s) setStatus(s); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  if (gone) return <p className="text-sm text-error">{m.node_gone()}</p>;
  if (!status) return <span className="loading loading-spinner loading-sm" />;
  if (!status.folder) return <ChooseFolder onChosen={setStatus} />;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">{m.node_folder()}</h3>
        <code className="block truncate text-xs" title={status.folder?.path}>{status.folder?.path ?? m.node_none()}</code>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" onClick={() => act(node.chooseFolder)}>{m.node_choose_other()}</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(node.reveal)}>{m.node_show()}</button>
        </div>
        <p className="text-xs text-base-content/60">{m.node_reload()}</p>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">{m.node_plugins()}</h3>
        <p className="text-xs text-base-content/60">
          {status.uv.state === 'locating' && m.node_uv_locating()}
          {status.uv.state === 'downloading' && m.node_uv_downloading()}
          {status.uv.state === 'ready' && m.node_uv_ready({ version: status.uv.version ?? '' })}
          {status.uv.state === 'failed' && <span className="text-error">{m.node_uv_failed({ error: status.uv.error ?? '' })}</span>}
        </p>
        {status.plugins.length === 0 && <p>{m.node_no_plugins()}</p>}
        {status.plugins.map((p) => (
          <div key={p.id}>
            {m.node_plugin({ id: p.id, version: p.version, state: STATE(m)[p.state] ?? p.state })}
            {p.error && <p className="text-xs text-error">{p.error}</p>}
          </div>
        ))}
      </section>

      {status.clients.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{m.node_clients()}</h3>
          {status.clients.map((c) => <div key={c.origin} className="truncate text-xs">{m.node_client({ origin: c.origin, seconds: c.seconds_ago })}</div>)}
        </section>
      )}

      <div className="flex items-center gap-2 border-t border-base-300 pt-2">
        {status.autostart !== null && (
          <label className="label flex-1 cursor-pointer gap-2">
            <input type="checkbox" className="checkbox checkbox-sm" checked={status.autostart}
              onChange={(e) => act(() => node.setAutostart(e.target.checked))} />
            {m.node_autostart()}
          </label>
        )}
        <button type="button" className="btn btn-sm btn-ghost ms-auto" onClick={() => act(node.quit)}>{m.node_quit()}</button>
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
      <p className="text-xs text-base-content/50">{m.node_version({ version: status.version, address: status.address })}</p>
    </div>
  );
}

/** The first start: the ymls live in a folder the user picks. */
function ChooseFolder({ onChosen }: { onChosen: (s: NodeStatus) => void }) {
  const { m } = useLang();
  const [error, setError] = useState<string>();
  const choose = () => {
    setError(undefined);
    node.chooseFolder().then(onChosen, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex flex-col gap-3">
      <p>{m.node_first()}</p>
      <button type="button" className="btn btn-primary self-start" onClick={choose}>{m.node_choose()}</button>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}
