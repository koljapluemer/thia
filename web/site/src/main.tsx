import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Catalog, ENTRIES, entryAt } from './Catalog';
import { HomeProvider } from './home';
import { Lesson, lessonId } from './Lesson';
import { Outline, outlineAt } from './Outline';
import { Notice } from './Run';
import { ViewPage } from './View';
import './app.css';

/**
 * The use app, by path: `/` everything on it, `/v/<view>[/<deck>]` one of them on the user's store, `/o/<outline>[/<entry>]`
 * a curriculum or guide with the views under its entries, `/l/<lesson>` a published lesson (on the lesson domain,
 * from its link, on a store of its own).
 */
function Site() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener('popstate', update);
    return () => removeEventListener('popstate', update);
  }, []);
  // a view opened from an outline goes back to it (as the link there names it now), else to everything
  const open = (to: string) => {
    history.pushState({ from: location.pathname.startsWith('/o/') ? location.pathname : '/' }, '', to);
    setPath(location.pathname);
    scrollTo(0, 0);
  };
  const back = () => open((history.state as { from?: string } | null)?.from ?? '/');
  const lesson = lessonId(path);
  const entry = entryAt(path);
  const outline = outlineAt(path);
  useEffect(() => { if (!entry && !lesson && !outline) document.title = 'thia'; }, [entry, lesson, outline]);

  if (lesson) return <Lesson id={lesson} />;
  return (
    <HomeProvider>
      {entry ? <ViewPage key={path} entry={entry} back={back} open={open} />
        : outline ? <Outline key={outline.name} name={outline.name} entry={outline.entry} open={open} />
        : path === '/' || path === '' ? <Catalog open={open} />
        : <Notice title="Nothing here"><a className="link" href="/">See everything there is</a>, or open the link you were given again.</Notice>}
    </HomeProvider>
  );
}

// an `?open=<view>&<params>` link, as the gestalter made them: that view's page, there
const asked = new URLSearchParams(location.search);
const view = asked.get('open');
if (view) {
  asked.delete('open');
  const hash = asked.toString();
  const to = ENTRIES.find((e) => e.plugin.manifest.id === view)?.path ?? '/';
  history.replaceState(null, '', `${to}${hash ? `#${hash}` : ''}`);
}

createRoot(document.getElementById('app')!).render(<StrictMode><Site /></StrictMode>);
