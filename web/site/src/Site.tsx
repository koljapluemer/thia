import { useEffect, useState } from 'react';
import type { OutlineTree } from '@gestalts/host';
import { Catalog, entryAt } from './Catalog';
import { HomeProvider } from './home';
import { Lesson, lessonId } from './Lesson';
import { Outline, outlineAt } from './Outline';
import { Notice } from './Run';
import { ViewPage } from './View';

/** What a page needs before it renders, so the prerendered page and the hydrated one are the same: an outline's tree. */
export type PageData = { tree?: OutlineTree };

/**
 * The use app, by path: `/` everything on it, `/v/<view>[/<deck>]` one of them on the user's store, `/o/<outline>[/<entry>]`
 * a curriculum or guide with the views under its entries, `/l/<lesson>` a published lesson (on the lesson domain,
 * from its link, on a store of its own). `path` and `data` are where it starts: the prerendered page's, or the
 * browser's; from then on it follows the browser's history.
 */
export function Site({ path: start, data }: { path: string; data?: PageData }) {
  const [path, setPath] = useState(start);
  const [tree, setTree] = useState(data?.tree);
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
        : outline ? <Outline key={outline.name} name={outline.name} entry={outline.entry} open={open} tree={tree?.name === outline.name ? tree : undefined} onTree={setTree} />
        : path === '/' || path === '' ? <Catalog open={open} />
        : <Notice title="Nothing here"><a className="link" href="/">See everything there is</a>, or open the link you were given again.</Notice>}
    </HomeProvider>
  );
}
