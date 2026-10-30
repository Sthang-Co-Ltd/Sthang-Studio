import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_EDITOR_LAYOUT, editorGeometry, editorResizeBounds, moveEditorPane, parseEditorLayout, PANE_MINIMUMS, resizeEditorBoundary, visibleEditorPanes, type EditorPane } from '../apps/web/src/editor-layout-state.js';

const orders: EditorPane[][] = [['preview','captions','inspector'],['preview','inspector','captions'],['captions','preview','inspector'],['inspector','preview','captions'],['captions','inspector','preview'],['inspector','captions','preview']];
test('all pane orders survive three/two/three transitions and two-pane swaps keep the hidden Tool slot', () => {
  for (const order of orders) {
    const visible = visibleEditorPanes(order, false);
    const next = moveEditorPane(order, false, visible[0], 1);
    assert.equal(next[order.indexOf('inspector')], 'inspector');
    assert.deepEqual(visibleEditorPanes(next, false), [...visible].reverse());
    assert.deepEqual(moveEditorPane(next, false, visible[0], 0), order);
  }
});
test('adjacent pair resizing respects minima and conserves the untouched panel for every order', () => {
  for (const width of [1176, 1440, 2048, 7680]) for (const order of orders) for (const boundary of [0,1]) {
    const state = { ...DEFAULT_EDITOR_LAYOUT, order };
    const geometry = editorGeometry(width, true, state);
    const [left,right] = order.slice(boundary,boundary+2);
    const untouched = order.find((pane) => pane !== left && pane !== right)!;
    for (const delta of [-100000,-16,16,100000]) {
      const next = resizeEditorBoundary(state,geometry,true,left,right,delta);
      const result = editorGeometry(width,true,next);
      for (const pane of order) assert.ok(result.widths[pane] >= PANE_MINIMUMS[pane] - 1);
      assert.equal(result.widths[untouched],geometry.widths[untouched]);
      assert.equal(Object.values(result.widths).reduce((sum,value) => sum+value,0),geometry.space);
      assert.deepEqual(parseEditorLayout(JSON.stringify(next)),next, 'every resizable preference must round-trip');
    }
    const bounds = editorResizeBounds(geometry,true,left,right);
    assert.ok(bounds.minimum <= 0 && bounds.maximum >= 0);
  }
});
test('opening and closing Tool never changes Preview allocation, including after two-pane resize', () => {
  for (const order of orders) {
    const state = { ...DEFAULT_EDITOR_LAYOUT,order };
    const open = editorGeometry(1600,true,state); const closed = editorGeometry(1600,false,state);
    assert.equal(open.widths.preview,closed.widths.preview);
    assert.equal(closed.widths.captions,open.widths.captions+open.widths.inspector+8);
    const visible = visibleEditorPanes(order,false);
    const resized = resizeEditorBoundary(state,closed,false,visible[0],visible[1],80);
    assert.equal(editorGeometry(1600,false,resized).widths.preview,editorGeometry(1600,true,resized).widths.preview);
  }
});
test('legacy widths migrate without mutating input and malformed or unbounded data is rejected', () => {
  assert.deepEqual(parseEditorLayout('{"preview":0.4,"inspector":0.3}',true),{ preview:.4,inspector:.3,order:DEFAULT_EDITOR_LAYOUT.order });
  for (const raw of [null,'{bad','null','[]','{"preview":1,"inspector":0.3,"order":["preview","captions","inspector"]}', ...[
    ['preview','preview','inspector'],['captions','inspector'],['preview','captions','other'],['preview','captions','inspector','captions'],
  ].map((order) => JSON.stringify({ preview:.36,inspector:.28,order }))]) assert.equal(parseEditorLayout(raw),null);
});
