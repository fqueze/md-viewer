/**
 * Tests for `mdvReviewMarkSent`: what the program driving the page has taken
 * stays on the page, read-only, and leaves what is read out next time.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { annotatedPage } from './helpers/page.js';

const plain = (value) => JSON.parse(JSON.stringify(value));

const EARLIER = {
  id: 'e1',
  anchor: { file: 'a.js', line: 2, side: 'new' },
  author: 'smaug',
  body: 'Why?',
  state: 'open',
  responses: ['done', 'reply'],
};

test('sent comments and responses stay shown, read-only, and are read out no more', async () => {
  const p = await annotatedPage({ comments: [EARLIER] });
  const { window, document } = p;
  const changes = [];
  document.addEventListener('mdv-review-change', (event) => changes.push(event.detail.count));

  await p.selectText(document.querySelector('.dv-line-add .dv-text'), 'three');
  p.comment('first');
  const box = document.querySelector('.mdv-respond-done input');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));

  const [first] = window.mdvReviewComments();
  window.mdvReviewMarkSent([first.id, 'e1']);

  assert.deepEqual(plain(window.mdvReviewComments()), []);
  assert.deepEqual(plain(window.mdvReviewResponses()), []);
  assert.equal(window.mdvReviewEntries([first]), '', 'entries leave a sent comment out too');
  assert.equal(changes.at(-1), 0);
  assert.equal(document.getElementById('mdv-review').hidden, true);

  // The comment is still marked, as sent, and its box only shows it.
  const mark = document.querySelector(`mark[data-comment-id="${first.id}"]`);
  assert.ok(mark.classList.contains('mdv-mark-sent'));
  mark.click();
  const textarea = document.querySelector('.mdv-review-box textarea');
  assert.equal(textarea.value, 'first');
  assert.equal(textarea.readOnly, true);
  textarea.value = '';
  textarea.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.ok(document.querySelector(`mark[data-comment-id="${first.id}"]`), 'emptying it does not delete it');

  // The response is shown as sent, its controls disabled.
  const thread = document.querySelector('.mdv-thread');
  assert.equal(thread.querySelector('.mdv-thread-sent').textContent, 'response sent');
  assert.equal(thread.querySelector('.mdv-respond-done input').checked, true);
  assert.equal(thread.querySelector('.mdv-respond-done input').disabled, true);
  assert.equal(thread.querySelector('.mdv-respond-reply').disabled, true);

  // What is written after is all the next send has.
  await p.selectText(document.querySelector('.dv-line-del .dv-text'), 'two');
  p.comment('second');
  assert.deepEqual(plain(window.mdvReviewComments().map((c) => c.text)), ['second']);
  assert.match(window.mdvReviewEntries(window.mdvReviewComments()), /second/);
  assert.doesNotMatch(window.mdvReviewEntries(window.mdvReviewComments()), /first/);
});

test('marking ids the page does not have changes nothing', async () => {
  const p = await annotatedPage({ comments: [EARLIER] });
  await p.selectText(p.document.querySelector('.dv-line-add .dv-text'), 'three');
  p.comment('kept');
  p.window.mdvReviewMarkSent(['nope', 'e1']);
  assert.equal(p.window.mdvReviewComments().length, 1);
  assert.equal(p.document.querySelector('.mdv-thread-sent'), null, 'e1 had no response to send');
});
