import test from 'node:test';
import assert from 'node:assert/strict';
import type { CaptionProject, RegenerationProposal } from '@kcs/shared';
import { createProjectScope, groupingChangesWording, projectMediaKey, proposalForProject } from '../apps/web/src/project-scope.js';

const project = (id = 'A'): CaptionProject => ({
  id, title: id, createdAt: '2026-01-01', updatedAt: '2026-01-01', mode: 'dynamic',
  media: { filename: `${id}.mp4`, originalName: `${id}.mp4`, url: `/media/${id}.mp4`, size: 100, mimeType: 'video/mp4' },
  captions: [{ id: 'c', text: 'ខ្មែរ', startMs: 0, endMs: 1000 }],
  transcript: { language: 'km', fullText: 'ខ្មែរ', segments: [], tokens: [
    { id: 't', text: 'ខ្មែរ', startMs: 0, endMs: 1000, spaceBefore: false, timingSource: 'stt' },
  ] },
});
const proposal: RegenerationProposal = {
  id: 'p', projectId: 'A', projectTitle: 'A', createdAt: '2026-01-01', expiresAt: '2026-01-02',
  startMs: 0, endMs: 61000, lockedCaptionsPreserved: 0, unchangedCount: 0,
  changes: [], currentCaptions: [], proposedCaptions: [], passNumber: 1, strategy: 'standard',
};

test('caption saves and appearance changes do not change the playback key', () => {
  const p = project(); const scope = createProjectScope(); scope.select(p); const ticket = scope.capture();
  const edited = { ...p, updatedAt: '2026-02-01', captions: [] };
  scope.select(edited);
  assert.equal(scope.isCurrent(ticket), true);
  assert.equal(projectMediaKey(edited), projectMediaKey(p));
});
test('project, filename, media size, URL and MIME changes invalidate playback work', () => {
  const p = project();
  for (const next of [project('B'), ...[
    { filename: 'replacement.mp4' }, { size: 101 }, { url: '/media/replacement.mp4' }, { mimeType: 'audio/wav' },
  ].map((change) => ({ ...p, media: { ...p.media, ...change } }))]) {
    const scope = createProjectScope(); scope.select(p); const ticket = scope.capture(); scope.select(next);
    assert.equal(scope.isCurrent(ticket), false);
  }
});
test('leaving and returning to identical media does not accept old responses', () => {
  const scope = createProjectScope(); const p = project(); scope.select(p); const old = scope.capture();
  scope.invalidate(); scope.select(null); scope.select(p);
  assert.equal(scope.isCurrent(old), false);
});
test('superseded navigation invalidates responses even before another project loads', () => {
  const scope = createProjectScope(); scope.select(project()); const old = scope.capture();
  scope.invalidate();
  assert.equal(scope.capture().key, old.key);
  assert.equal(scope.isCurrent(old), false);
});
test('proposals require both current session ownership and matching project', () => {
  const p = project(); const scope = createProjectScope(); scope.select(p); const ticket = scope.capture();
  const entry = { ticket, value: proposal };
  assert.equal(proposalForProject(entry, ticket, p), proposal);
  assert.equal(proposalForProject(entry, ticket, project('B')), null);
  assert.equal(proposalForProject(entry, ticket, null), null);
  assert.equal(proposalForProject(null, ticket, p), null);
  assert.equal(proposalForProject({ ticket, value: { ...proposal, projectId: 'B' } }, ticket, p), null);
  scope.invalidate(); assert.equal(proposalForProject(entry, scope.capture(), p), null);
});
test('media replacement hides an old proposal for the same project id', () => {
  const p = project(); const scope = createProjectScope(); scope.select(p);
  const entry = { ticket: scope.capture(), value: proposal };
  const replacement = { ...p, media: { ...p.media, filename: 'new.mp4' } };
  scope.select(replacement);
  assert.equal(proposalForProject(entry, scope.capture(), replacement), null);
});
test('grouping wording comparison ignores grouping whitespace but not corrections', () => {
  const p = project();
  assert.equal(groupingChangesWording(p, [{ ...p.captions[0], text: 'ខ្មែរ\n ' }]), false);
  assert.equal(groupingChangesWording(p, [{ ...p.captions[0], text: 'កម្ពុជា' }]), true);
  assert.equal(groupingChangesWording({ ...p, transcriptNeedsSync: true }, p.captions), true);
  assert.equal(groupingChangesWording({ ...p, transcript: null }, p.captions), true);
});
test('media keys cannot collide through delimiter-like project/filename contents', () => {
  const p = project();
  assert.notEqual(projectMediaKey({ ...p, id: 'A:B' }), projectMediaKey({ ...p, media: { ...p.media, filename: 'B:A.mp4' } }));
});
