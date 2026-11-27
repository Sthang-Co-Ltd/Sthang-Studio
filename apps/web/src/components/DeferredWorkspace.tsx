import { Component, Suspense, lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import { useI18n } from '../i18n';
import type { MessageKey } from '../i18n/types';
import './workspace-loading.css';

type WorkspacePresentation = { name: MessageKey; shape: 'appearance' | 'timing' | 'export' | 'comparison' };

function WorkspaceLoading({ name, shape }: WorkspacePresentation) {
  const { t } = useI18n();
  return <div className={`workspace-loading workspace-loading-${shape}`} role="status">
    <p>{t('workspace.loading.opening', { name: t(name) })}</p>
    <div className="workspace-loading-shape" aria-hidden="true">
      <div className="workspace-loading-preview"><span/><span/><span/></div>
      <div className="workspace-loading-fields">{[0, 1, 2].map((key) => <div key={key} className="workspace-loading-field"><span/><i/></div>)}</div>
    </div>
  </div>;
}

class WorkspaceError extends Component<{ children: ReactNode; name: string; t: ReturnType<typeof useI18n>['t']; onRetry(trigger: HTMLButtonElement): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    const { t, name } = this.props;
    if (this.state.failed) return <div className="workspace-load-error" role="alert" aria-label={t('workspace.loading.failedLabel', { name })}>
      <p>{t('workspace.loading.failed')}</p>
      <button type="button" onClick={(event) => this.props.onRetry(event.currentTarget)}>{t('workspace.loading.retry')}</button>
    </div>;
    return this.props.children;
  }
}

/** Declare at module scope. A tool's chunk failure never replaces the media/editor. */
export function deferWorkspace<C extends ComponentType<any>>(load: () => Promise<{ default: C }>, presentation: WorkspacePresentation, recover = load) {
  // Reuse the lazy wrapper (and its resolved module) across workspace remounts.
  // Only an explicit retry replaces it; no import is started by this declaration.
  let currentView = lazy(load);
  return function DeferredWorkspace(props: ComponentProps<C>) {
    const { t } = useI18n();
    const [attempt, setAttempt] = useState(() => ({ id: 0, View: currentView }));
    // lazy preserves C's props. Normalize its exotic JSX type only at this
    // boundary; callers still require the exact ComponentProps<C> contract.
    const View = attempt.View as ComponentType<ComponentProps<C>>;
    const retry = (trigger: HTMLButtonElement) => {
      // The retry button disappears with its failed boundary. Keep keyboard
      // focus on the persistent tool shell before starting the fresh import.
      if (document.activeElement === trigger) {
        const close = trigger.closest('.workspace-inspector')?.querySelector<HTMLButtonElement>('[data-workspace-close]');
        close?.focus({ preventScroll: true });
        close?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
      const nextView = lazy(recover);
      currentView = nextView;
      setAttempt(({ id }) => ({ id: id + 1, View: nextView }));
    };
    return <WorkspaceError key={attempt.id} name={t(presentation.name)} t={t} onRetry={retry}>
      <Suspense fallback={<WorkspaceLoading {...presentation}/>}>
        <View {...props}/>
      </Suspense>
    </WorkspaceError>;
  };
}
