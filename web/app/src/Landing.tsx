import { AreaLink, SITE, useAreas } from './router';

/** Where to go: a card per area. */
export function Landing() {
  const areas = useAreas();
  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-8">
      <h1 className="mb-6 text-2xl font-semibold">gestalts</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {areas.map((a) => (
          <AreaLink key={a.path} path={a.path} className="card card-border bg-base-100 transition hover:bg-base-200">
            <div className="card-body">
              <h2 className="card-title">{a.title}</h2>
              <p className="text-base-content/70">{a.about}</p>
            </div>
          </AreaLink>
        ))}
        <a href={SITE} className="card card-border bg-base-100 transition hover:bg-base-200">
          <div className="card-body">
            <h2 className="card-title">The public site</h2>
            <p className="text-base-content/70">The learning views and visualizations, and what the workshops made, for anyone.</p>
          </div>
        </a>
      </div>
    </main>
  );
}
