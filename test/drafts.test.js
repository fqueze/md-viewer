/**
 * Tests for drafts: a commit's unsent comments and responses are kept in
 * localStorage as they are typed, and come back when the commit is shown
 * again.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { SHA, annotatedPage } from './helpers/page.js';

const plain = (value) => JSON.parse(JSON.stringify(value));

const EARLIER = {
  id: 'e1',
  anchor: { file: 'a.js', line: 2, side: 'new' },
  author: 'smaug',
  body: 'Why?',
  state: 'open',
  responses: ['address', 'reply'],
};

/** Everything a page left in its localStorage, to start the next one with. */
function left(window) {
  const out = {};
  for (let i = 0; i < window.localStorage.length; i++) {
    const key = window.localStorage.key(i);
    out[key] = window.localStorage.getItem(key);
  }
  return out;
}

test('comments and responses come back when the commit is shown again', async () => {
  const first = await annotatedPage({ comments: [EARLIER] });
  await first.selectText(first.document.querySelector('.dv-line-add .dv-text'), 'three');
  first.comment('why three');
  const thread = first.document.querySelector('.mdv-thread');
  thread.querySelector('.mdv-respond-reply').click();
  const area = thread.querySelector('.mdv-reply');
  area.value = 'Because.';
  area.dispatchEvent(new first.window.Event('input', { bubbles: true }));
  first.document.querySelector('.mdv-thread .mdv-respond-address').click();

  const storage = left(first.window);
  assert.deepEqual(Object.keys(storage).sort(), [
    `mdv-review-drafts:v1:${SHA}:comments`,
    `mdv-review-drafts:v1:${SHA}:responses`,
  ]);

  const again = await annotatedPage({ comments: [EARLIER] }, undefined, { storage });
  const [comment] = again.window.mdvReviewComments();
  const [original] = first.window.mdvReviewComments();
  assert.equal(comment.id, original.id, 'the same comment, by its id');
  assert.equal(comment.text, 'why three');
  assert.deepEqual(plain(comment.anchor), { file: 'a.js', line: 2, side: 'new' });
  assert.ok(again.document.querySelector(`mark[data-comment-id="${comment.id}"]`), 'highlighted again');
  assert.equal(again.document.getElementById('mdv-review').hidden, false);
  assert.deepEqual(plain(again.window.mdvReviewResponses()), [
    { id: 'e1', response: 'address', text: 'Because.' },
  ]);
  const restored = again.document.querySelector('.mdv-thread');
  assert.equal(restored.querySelector('.mdv-reply').value, 'Because.');
  assert.equal(restored.querySelector('.mdv-respond-address').getAttribute('aria-pressed'), 'true');
});

test('a comment being typed is kept as it is typed', async () => {
  const first = await annotatedPage({});
  await first.selectText(first.document.querySelector('.dv-line-add .dv-text'), 'three');
  const textarea = first.document.querySelector('.mdv-review-box textarea');
  textarea.value = 'half writ';
  textarea.dispatchEvent(new first.window.Event('input', { bubbles: true }));

  const again = await annotatedPage({}, undefined, { storage: left(first.window) });
  assert.deepEqual(plain(again.window.mdvReviewComments().map((c) => c.text)), ['half writ']);
});

test('sent and deleted ones are dropped from the drafts', async () => {
  const first = await annotatedPage({ comments: [EARLIER] });
  const { window, document } = first;
  await first.selectText(document.querySelector('.dv-line-add .dv-text'), 'three');
  first.comment('sent one');
  await first.selectText(document.querySelector('.dv-line-del .dv-text'), 'two');
  first.comment('deleted one');
  document.querySelector('.mdv-thread .mdv-respond-address').click();

  const [sent, deleted] = window.mdvReviewComments();
  window.mdvReviewMarkSent([sent.id, 'e1']);
  // Emptying a comment and saving deletes it.
  document.querySelector(`mark[data-comment-id="${deleted.id}"]`).click();
  first.comment('');

  assert.deepEqual(left(window), {});
  const again = await annotatedPage({ comments: [EARLIER] }, undefined, { storage: left(window) });
  assert.equal(again.window.mdvReviewComments().length, 0);
  assert.equal(again.window.mdvReviewResponses().length, 0);
});

test("another commit's drafts stay its own", async () => {
  const first = await annotatedPage({});
  await first.selectText(first.document.querySelector('.dv-line-add .dv-text'), 'three');
  first.comment('mine');
  const other = await annotatedPage({}, undefined, {
    storage: left(first.window),
    page: { commit: '2222222222222222222222222222222222222222' },
  });
  assert.equal(other.window.mdvReviewComments().length, 0);
});

test("a commit's drafts outlive its sha under the annotation's draftKey: a rebase, a bug number put in its message", async () => {
  const first = await annotatedPage({ draftKey: 'r-1:p-a', comments: [EARLIER] });
  await first.selectText(first.document.querySelector('.dv-line-add .dv-text'), 'three');
  first.comment('why three');
  first.document.querySelector('.mdv-thread .mdv-respond-address').click();
  assert.deepEqual(Object.keys(left(first.window)).sort(), ['mdv-review-drafts:v1:r-1:p-a:comments', 'mdv-review-drafts:v1:r-1:p-a:responses']);

  const rewritten = { commit: '3333333333333333333333333333333333333333' };
  const again = await annotatedPage({ draftKey: 'r-1:p-a', comments: [EARLIER] }, undefined, { storage: left(first.window), page: rewritten });
  assert.deepEqual(plain(again.window.mdvReviewComments().map((c) => c.text)), ['why three']);
  assert.deepEqual(plain(again.window.mdvReviewResponses()), [{ id: 'e1', response: 'address' }]);
  const other = await annotatedPage({ draftKey: 'r-1:p-b' }, undefined, { storage: left(first.window), page: rewritten });
  assert.equal(other.window.mdvReviewComments().length, 0, "another patch's key");
});
