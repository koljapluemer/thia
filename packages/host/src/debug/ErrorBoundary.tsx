import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useLang } from '@gestalts/i18n';
import { logger } from '@gestalts/view';

const log = logger('ui');

type Props = { children: ReactNode; /** what's inside, for the log */ name?: string };

/** Logs a render error (with its component stack) and shows it, instead of a blank pane; Retry renders again. */
export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    log.error('render error', { in: this.props.name, error, componentStack: info.componentStack ?? undefined });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <Broke name={this.props.name} error={this.state.error} retry={() => this.setState({ error: null })} />;
  }
}

function Broke({ name, error, retry }: { name?: string; error: Error; retry: () => void }) {
  const { m } = useLang();
  return (
    <div className="flex justify-center p-4">
      <div role="alert" className="alert alert-error max-w-lg">
        <span>{name ? m.broke_in({ name, error: error.message }) : m.broke({ error: error.message })}</span>
        <button type="button" className="btn btn-sm" onClick={retry}>{m.retry()}</button>
      </div>
    </div>
  );
}
