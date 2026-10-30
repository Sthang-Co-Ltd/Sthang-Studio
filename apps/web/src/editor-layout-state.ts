export type EditorPane = 'preview' | 'captions' | 'inspector';
export interface EditorLayoutPreference { preview: number; inspector: number; order: EditorPane[] }
export const EDITOR_LAYOUT_KEY = 'sthang:editor-layout:v2';
export const LEGACY_EDITOR_LAYOUT_KEY = 'sthang:editor-layout:v1';
export const EDITOR_LAYOUT_CHANGE = 'sthang:editor-layout-change';
export const DEFAULT_EDITOR_LAYOUT: EditorLayoutPreference = { preview: .36, inspector: .28, order: ['preview', 'captions', 'inspector'] };
export const PANE_LABELS = { preview: 'Preview', captions: 'Captions', inspector: 'Tool' };
export const PANE_MINIMUMS = { preview: 320, captions: 360, inspector: 360 };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function parseEditorLayout(raw: string | null, legacy = false): EditorLayoutPreference | null {
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || ![value.preview, value.inspector].every((item) => typeof item === 'number' && Number.isFinite(item) && item > 0 && item < 1)) return null;
    const order = legacy ? DEFAULT_EDITOR_LAYOUT.order : value.order;
    if (!Array.isArray(order) || order.length !== 3 || new Set(order).size !== 3 || !order.every((pane) => DEFAULT_EDITOR_LAYOUT.order.includes(pane))) return null;
    return { preview: value.preview, inspector: value.inspector, order: [...order] };
  } catch { return null; }
}

export function visibleEditorPanes(order: EditorPane[], open: boolean) {
  return order.filter((pane) => open || pane !== 'inspector');
}

/** Hidden Tool keeps its slot. Moving two visible panes cannot lose that preference. */
export function moveEditorPane(order: EditorPane[], open: boolean, pane: EditorPane, to: number): EditorPane[] {
  const visible = visibleEditorPanes(order, open);
  const from = visible.indexOf(pane);
  if (from < 0) return order;
  const next = [...visible]; next.splice(from, 1); next.splice(clamp(to, 0, next.length), 0, pane);
  let index = 0;
  return order.map((item) => !open && item === 'inspector' ? item : next[index++]);
}

export function editorGeometry(width: number, open: boolean, preference: EditorLayoutPreference) {
  // The preview uses the same basis with two or three panes, avoiding a size jump
  // when a tool opens. Caption space absorbs the closed inspector and its divider.
  const space = Math.max(1040, width - 16);
  const preview = clamp(Math.round(space * preference.preview), 320, space - 720);
  const inspector = clamp(Math.round(space * preference.inspector), 360, space - preview - 360);
  return { space, widths: { preview, inspector, captions: space - preview - (open ? inspector : -8) } };
}

export function editorResizeBounds(geometry: ReturnType<typeof editorGeometry>, open: boolean, left: EditorPane, right: EditorPane) {
  const { widths, space } = geometry;
  let minimum = PANE_MINIMUMS[left] - widths[left];
  let maximum = widths[right] - PANE_MINIMUMS[right];
  // Retain room for the remembered Tool width when it returns.
  if (!open) {
    const maxPreview = space - widths.inspector - PANE_MINIMUMS.captions;
    if (left === 'preview') maximum = Math.min(maximum, maxPreview - widths.preview);
    if (right === 'preview') minimum = Math.max(minimum, widths.preview - maxPreview);
  }
  return { minimum, maximum };
}

/** A boundary always redistributes its two actual neighbors, including Preview–Tool. */
export function resizeEditorBoundary(preference: EditorLayoutPreference, geometry: ReturnType<typeof editorGeometry>, open: boolean, left: EditorPane, right: EditorPane, delta: number): EditorLayoutPreference {
  const bounds = editorResizeBounds(geometry, open, left, right);
  const change = clamp(delta, bounds.minimum, bounds.maximum);
  const widths = { ...geometry.widths, [left]: geometry.widths[left] + change, [right]: geometry.widths[right] - change };
  return { ...preference, preview: widths.preview / geometry.space, inspector: widths.inspector / geometry.space };
}
