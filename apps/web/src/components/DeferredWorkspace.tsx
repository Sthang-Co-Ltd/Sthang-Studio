import { Component, Suspense, lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';
import './workspace-loading.css';

type WorkspacePresentation = { name: string; shape: 'appearance' | 'timing' | 'export' | 'comparison' };

function WorkspaceLoading({ name, shape }: WorkspacePresentation) {
  return <div className={`workspace-loading workspace-loading-${shape}`} role="status">
    <p>Opening {name}…</p>
    <div className="workspace-loading-shape" aria-hidden="true">
      <div className="workspace-loading-preview"><span/><span/><span/></div>
      <div className="workspace-loading-fields">{[0, 1, 2].map((key) => <div key={key} className="workspace-loading-field"><span/><i/></div>)}</div>
    </div>
  </div>;
}

class WorkspaceError extends Component<{ children: ReactNode; name: string; onRetry(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="workspace-load-error" role="alert" aria-label={`${this.props.name} could not load`}>
      <p>This tool could not load. Your captions remain available.</p>
      <button onClick={this.props.onRetry}>Retry loading tool</button>
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
    const [attempt, setAttempt] = useState(() => ({ id: 0, View: currentView }));
    // lazy preserves C's props. Normalize its exotic JSX type only at this
    // boundary; callers still require the exact ComponentProps<C> contract.
    const View = attempt.View as ComponentType<ComponentProps<C>>;
    const retry = () => {
      const nextView = lazy(recover);
      currentView = nextView;
      setAttempt(({ id }) => ({ id: id + 1, View: nextView }));
    };
    return <WorkspaceError key={attempt.id} name={presentation.name} onRetry={retry}>
      <Suspense fallback={<WorkspaceLoading {...presentation}/>}>
        <View {...props}/>
      </Suspense>
    </WorkspaceError>;
  };
}
