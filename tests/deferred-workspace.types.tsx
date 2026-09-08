// Compile-only regression fixtures, included by tests/tsconfig.json.
// The loader must infer the component first, not collapse its props to never/any.
import { Component } from 'react';
import { deferWorkspace } from '../apps/web/src/components/DeferredWorkspace';

interface ToolProps { projectId: string; onSelect(id: string): void; zoom?: number }
function FunctionTool({ projectId, onSelect }: ToolProps) {
  return <button onClick={() => onSelect(projectId)}>{projectId}</button>;
}
const DeferredFunction = deferWorkspace(async () => ({ default: FunctionTool }));
const validFunction = <DeferredFunction projectId="synthetic" onSelect={(id) => id.toUpperCase()}/>;
// @ts-expect-error projectId must remain required.
const missingProject = <DeferredFunction onSelect={() => {}}/>;
// @ts-expect-error onSelect must retain its string argument contract.
const invalidCallback = <DeferredFunction projectId="synthetic" onSelect={(id: number) => {}}/>;
// @ts-expect-error arbitrary props must not leak through the helper's generic constraint.
const extraProp = <DeferredFunction projectId="synthetic" onSelect={() => {}} unexpected/>;

class ClassTool extends Component<ToolProps> {
  render() { return <span>{this.props.projectId}</span>; }
}
const DeferredClass = deferWorkspace(async () => ({ default: ClassTool }));
const validClass = <DeferredClass projectId="synthetic" onSelect={() => {}} zoom={2}/>;
// @ts-expect-error class components must also retain required props.
const missingCallback = <DeferredClass projectId="synthetic"/>;
void [validFunction, missingProject, invalidCallback, extraProp, validClass, missingCallback];
