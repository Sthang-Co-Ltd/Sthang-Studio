import { Component, Suspense, lazy, useState, type ComponentType, type ReactNode } from 'react';

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
export function deferWorkspace<P extends object>(load: () => Promise<{ default: ComponentType<P> }>) {
  return function DeferredWorkspace(props: P) {
    const [attempt, setAttempt] = useState(() => ({ id: 0, View: lazy(load) }));
    // React.lazy preserves the loaded component's props.
    const View = attempt.View as ComponentType<P>;
    return <WorkspaceError key={attempt.id} onRetry={() => setAttempt(({ id }) => ({ id: id + 1, View: lazy(load) }))}>
      <Suspense fallback={<div className="review-empty" role="status">Loading tool…</div>}>
        <View {...props}/>
      </Suspense>
    </WorkspaceError>;
  };
}
