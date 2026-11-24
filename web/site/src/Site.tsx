import { useEffect, useState } from 'react';
import { registry } from 'virtual:gestalts-plugins';
import type { OutlineTree } from '@gestalts/host';
import { AVAILABLE, langPath, LangProvider, splitPath, useLang } from '@gestalts/i18n';
import { Catalog, entryAt } from './Catalog';
import { HomeProvider } from './home';
import { Lesson, lessonId } from './Lesson';
import { Outline, outlineAt } from './Outline';
import { Notice } from './Run';
import { ViewPage } from './View';

/** What a page needs before it renders, so the prerendered page and the hydrated one are the same: an outline's tree. */
export type PageData = { tree?: OutlineTree };

/**
 * The use app, by path: `/` everything on it (`/de/` in German, and so on for every language of the app), `/v/<view>[/<deck>]` one of them on the user's store, `/o/<outline>[/<entry>]`
 * a curriculum or guide with the views under its entries, `/l/<lesson>` a published lesson (on the lesson domain,
 * from its link, on a store of its own). `path` and `data` are where it starts: the prerendered page's, or the
 * browser's; from then on it follows the browser's history. The app's text is in the URL's language or, until the
 * person is known, the content's (a German curriculum's page is German); then in theirs ([`LangProvider`]).
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
  const { lang: urlLang, path: route } = splitPath(path, AVAILABLE);
  const lesson = lessonId(route);
  const entry = entryAt(route);
  const outline = outlineAt(route);
  useEffect(() => { if (!entry && !lesson && !outline) document.title = 'thia'; }, [entry, lesson, outline]);
  // a view's page is in its content's language, as an outline's is, until the person is known
  const content = outline ? registry.outlines?.find((o) => o.name === outline.name)?.lang : entry?.lang;

  return (
    <LangProvider url={urlLang} content={content}>
      {lesson ? <Lesson id={lesson} /> : (
        <HomeProvider>
          {entry ? <ViewPage key={route} entry={entry} back={back} open={open} />
            : outline ? <Outline key={outline.name} name={outline.name} entry={outline.entry} open={open} tree={tree?.name === outline.name ? tree : undefined} onTree={setTree} />
            : route === '/' || route === '' ? <Catalog open={open} />
            : <NotFound />}
        </HomeProvider>
      )}
    </LangProvider>
  );
}

/** Where everything is, in the app's language: `/`, `/de/`. */
export function useHomePath(): string {
  return langPath('/', useLang().lang);
}

/** A path the site doesn't have. */
export function NotFound() {
  const { m, lang } = useLang();
  return <Notice title={m.not_found()}>{m.not_found_text()} <a className="link" href={langPath('/', lang)}>{m.not_found_link()}</a></Notice>;
}
