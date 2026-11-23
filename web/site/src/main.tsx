import { StrictMode, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Catalog, entryAt, runOf } from './Catalog';
import { Lesson, lessonId } from './Lesson';
import { Notice, RunPage } from './Run';
import './app.css';

/**
 * The public site, by path: `/` everything on it, `/v/<view>/<deck>` one of them, `/l/<lesson>` a published lesson
 * (on the lesson domain, from its link).
 */
function Site() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const update = () => setPath(location.pathname);
    addEventListener('popstate', update);
    return () => removeEventListener('popstate', update);
  }, []);
  const open = (to: string) => {
    history.pushState(null, '', to);
    setPath(to);
    scrollTo(0, 0);
  };
  const lesson = lessonId(path);
  const entry = entryAt(path);
  const run = useMemo(() => entry && runOf(entry, () => open('/')), [entry]);
  useEffect(() => { if (!entry && !lesson) document.title = 'thia'; }, [entry, lesson]);

  if (lesson) return <Lesson id={lesson} />;
  if (run) return <RunPage key={path} run={run} />;
  if (path === '/' || path === '') return <Catalog open={open} />;
  return <Notice title="Nothing here"><a className="link" href="/">See everything there is</a>, or open the link you were given again.</Notice>;
}

createRoot(document.getElementById('app')!).render(<StrictMode><Site /></StrictMode>);
