import { useEffect, useState } from 'react';
import { PlugZap } from 'lucide-react';
import { useLang } from '@gestalts/i18n';
import * as api from './api';
import { Login } from './Workshop';

/** Where a chat app's request to connect (`/oauth/authorize`) sends the person: the page answers it. */
export const CONNECT = '/workshop/connect';

/**
 * A chat app (claude.ai) asks to work on the account's drafts: signed in, the person allows it or not, and goes back to
 * the app with the answer. The request is this page's query, as the server passed it on.
 */
export function Connect() {
  const { m } = useLang();
  const [req] = useState<api.ConnectRequest>(() => Object.fromEntries(new URLSearchParams(location.search)));
  const [me, setMe] = useState<api.Me | null>();
  const [app, setApp] = useState<{ name: string } | { error: string }>();
  const [going, setGoing] = useState(false);
  useEffect(() => { api.me().then(setMe, () => setMe(null)); }, []);
  useEffect(() => {
    if (!me) return;
    api.connectingApp(req).then(setApp, (e: unknown) => setApp({ error: e instanceof Error ? e.message : String(e) }));
  }, [me, req]);
  if (me === undefined) return <div className="flex h-dvh items-center justify-center"><span className="loading loading-spinner" /></div>;
  if (!me) return <Login onIn={setMe} />;
  const answer = async (allow: boolean) => {
    setGoing(true);
    try {
      const { redirect } = await (allow ? api.allowApp(req) : api.denyApp(req));
      location.assign(redirect);
    } catch (e) {
      setApp({ error: e instanceof Error ? e.message : String(e) });
      setGoing(false);
    }
  };
  return (
    <div className="flex min-h-dvh items-center justify-center bg-base-200 p-4">
      <div className="flex w-full max-w-md flex-col gap-3 rounded-box bg-base-100 p-6 shadow">
        {!app && <span className="loading loading-spinner" />}
        {app && 'error' in app && <p role="alert" className="text-error">{m.connect_failed({ error: app.error })}</p>}
        {app && 'name' in app && (
          <>
            <h1 className="flex items-center gap-2 text-lg font-semibold"><PlugZap className="size-5" /> {m.connect_title({ app: app.name })}</h1>
            <p>{m.connect_about({ app: app.name })}</p>
            <p className="text-sm text-base-content/60">{me.email}</p>
            {going
              ? <p className="text-base-content/60"><span className="loading loading-spinner loading-xs" /> {m.connect_going({ app: app.name })}</p>
              : (
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn btn-ghost" onClick={() => void answer(false)}>{m.cancel()}</button>
                  <button type="button" className="btn btn-primary" onClick={() => void answer(true)}>{m.connect_allow()}</button>
                </div>
              )}
          </>
        )}
      </div>
    </div>
  );
}
