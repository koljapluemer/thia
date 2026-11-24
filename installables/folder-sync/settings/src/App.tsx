import { LangPicker, useLang } from '@gestalts/i18n';
import { LlmSettings } from './LlmSettings';
import { Settings } from './Settings';

/** gestalts-node's own page: what the node does for the apps that use it. */
export function App() {
  const { m } = useLang();
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-6 p-4">
      <header>
        <div className="flex items-center gap-2">
          <h1 className="flex-1 text-xl font-semibold">gestalts-node</h1>
          <LangPicker />
        </div>
        <p className="text-sm text-base-content/70">{m.node_about()}</p>
      </header>
      <Settings />
      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">{m.node_llm()}</h2>
        <LlmSettings />
      </section>
    </main>
  );
}
