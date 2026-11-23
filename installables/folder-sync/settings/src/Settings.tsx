import { useEffect, useState } from 'react';
import { node, type NodeStatus } from './control';

const STATE: Record<string, string> = { stopped: 'stopped', starting: 'starting…', ready: 'ready', running: 'running', error: 'error' };

/** The node's settings: the folder, the plugins' workers, start on login. Refreshed while shown. */
export function Settings() {
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

  if (gone) return <p className="text-sm text-error">gestalts-node isn't running. Start it again; this page picks up where it was.</p>;
  if (!status) return <span className="loading loading-spinner loading-sm" />;
  if (!status.folder) return <ChooseFolder onChosen={setStatus} />;
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">Folder</h3>
        <code className="block truncate text-xs" title={status.folder?.path}>{status.folder?.path ?? 'none'}</code>
        <div className="flex gap-2">
          <button type="button" className="btn btn-sm" onClick={() => act(node.chooseFolder)}>Choose another folder…</button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => act(node.reveal)}>Show</button>
        </div>
        <p className="text-xs text-base-content/60">Apps using the node reload with the other folder's ymls.</p>
      </section>

      <section className="flex flex-col gap-1">
        <h3 className="font-semibold">Plugins</h3>
        <p className="text-xs text-base-content/60">
          {status.uv.state === 'locating' && 'Looking for uv…'}
          {status.uv.state === 'downloading' && 'Downloading uv, which runs the plugins…'}
          {status.uv.state === 'ready' && `uv ${status.uv.version}`}
          {status.uv.state === 'failed' && <span className="text-error">uv: {status.uv.error}</span>}
        </p>
        {status.plugins.length === 0 && <p>No plugins with workers.</p>}
        {status.plugins.map((p) => (
          <div key={p.id}>
            {p.id} {p.version} · {STATE[p.state] ?? p.state}
            {p.error && <p className="text-xs text-error">{p.error}</p>}
          </div>
        ))}
      </section>

      {status.clients.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">Connected apps</h3>
          {status.clients.map((c) => <div key={c.origin} className="truncate text-xs">{c.origin} · {c.seconds_ago} s ago</div>)}
        </section>
      )}

      <div className="flex items-center gap-2 border-t border-base-300 pt-2">
        {status.autostart !== null && (
          <label className="label flex-1 cursor-pointer gap-2">
            <input type="checkbox" className="checkbox checkbox-sm" checked={status.autostart}
              onChange={(e) => act(() => node.setAutostart(e.target.checked))} />
            Start on login
          </label>
        )}
        <button type="button" className="btn btn-sm btn-ghost ml-auto" onClick={() => act(node.quit)}>Quit gestalts-node</button>
      </div>
      {error && <p className="text-xs text-error">{error}</p>}
      <p className="text-xs text-base-content/50">v{status.version} · {status.address}</p>
    </div>
  );
}

/** The first start: the ymls live in a folder the user picks. */
function ChooseFolder({ onChosen }: { onChosen: (s: NodeStatus) => void }) {
  const [error, setError] = useState<string>();
  const choose = () => {
    setError(undefined);
    node.chooseFolder().then(onChosen, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="flex flex-col gap-3">
      <p>Your data lives in a folder on this computer, as plain files you can back up and sync like any others. Choose an
        empty folder to start, or one you've used before.</p>
      <button type="button" className="btn btn-primary self-start" onClick={choose}>Choose folder…</button>
      {error && <p className="text-sm text-error">{error}</p>}
    </div>
  );
}
