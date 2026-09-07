import { Component, Suspense, lazy, useState, type ComponentProps, type ComponentType, type ReactNode } from 'react';

class WorkspaceError extends Component<{ children: ReactNode; onRetry(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (this.state.failed) return <div className="review-empty" role="alert">
      <p>This tool could not load. Your captions remain available.</p>
      <button onClick={this.props.onRetry}>Retry loading tool</button>
    </div>;
    return this.props.children;
  }
}

/** Declare at module scope. A tool's chunk failure never replaces the media/editor. */
export function deferWorkspace<C extends ComponentType<any>>(load: () => Promise<{ default: C }>) {
  // Reuse the lazy wrapper (and its resolved module) across workspace remounts.
  // Only an explicit retry replaces it; no import is started by this declaration.
  let currentView = lazy(load);
  return function DeferredWorkspace(props: ComponentProps<C>) {
    const [attempt, setAttempt] = useState(() => ({ id: 0, View: currentView }));
    // lazy preserves C's props. Normalize its exotic JSX type only at this
    // boundary; callers still require the exact ComponentProps<C> contract.
    const View = attempt.View as ComponentType<ComponentProps<C>>;
    const retry = () => {
      const nextView = lazy(load);
      currentView = nextView;
      setAttempt(({ id }) => ({ id: id + 1, View: nextView }));
    };
    return <WorkspaceError key={attempt.id} onRetry={retry}>
      <Suspense fallback={<div className="review-empty" role="status">Loading tool…</div>}>
        <View {...props}/>
      </Suspense>
    </WorkspaceError>;
  };
}
