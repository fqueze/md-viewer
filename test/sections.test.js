/**
 * Tests for sections — the blocks of markdown a program adds between a
 * commit's message and its files, such as a test plan — and for what new
 * comments say about where they sit, on a file, the message or a section.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildStackPage } from '../lib/stack-page.js';
import { COMMIT, SHA, annotatedPage } from './helpers/page.js';

const PLAN = [
  'Ran the test **ten times**:', // 1
  '', // 2
  '- linux64 opt: 10/10', // 3
  '- macOS debug: 10/10', // 4
  '', // 5
  'Then a second run, which', // 6
  'starts from an empty profile.', // 7
  '', // 8
  '```', // 9
  './mach test a.js --verify', // 10
  '```', // 11
  '', // 12
  '<script>window.ran = true</script> is text', // 13
].join('\n');

/** A value from the page's realm, as one of this realm's for comparing. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const WITH_PLAN = { sections: [{ id: 'test-plan', title: 'Test plan', markdown: PLAN }] };

test("a section is drawn as markdown under the message, in its box", async () => {
  const p = await annotatedPage(WITH_PLAN);
  const { document } = p;
  const section = document.querySelector('.dv-section');
  assert.equal(section.dataset.section, 'test-plan');
  assert.equal(section.querySelector('.dv-section-title').textContent, 'Test plan');
  assert.equal(section.parentElement.classList.contains('dv-message'), true);
  assert.equal(section.previousElementSibling.classList.contains('dv-msg-table'), true);
  assert.equal(section.parentElement.nextElementSibling.classList.contains('dv-files'), true);
  assert.equal(section.querySelector('strong').textContent, 'ten times');
  assert.equal(section.querySelectorAll('li').length, 2);
  // What a program hands in is not the reader's own file: its HTML is text.
  assert.equal(p.window.ran, undefined);
  assert.match(section.textContent, /<script>window\.ran = true<\/script> is text/);
  // Not one of the files, which stack-viewer's list counts by their sections.
  assert.ok(!section.classList.contains('dv-file'));
});

test('a comment on a section names the section and the lines of its source', async () => {
  const p = await annotatedPage(WITH_PLAN);
  const section = p.document.querySelector('.dv-section');
  await p.selectText(section, 'empty profile');
  p.comment('which profile?');
  const [comment] = p.window.mdvReviewComments();
  assert.deepEqual(plain(comment.anchor), { file: '(section:test-plan)', line: 7 });
  assert.match(comment.id, /^c-/);

  const entries = p.window.mdvReviewEntries([comment]);
  assert.match(entries, /^- the Test plan section, line 7 — "empty profile"/);
  // Quoted from the markdown source, as prose.
  assert.match(entries, /starts from an empty profile\./);
  // Two lines either side, the fence of the code block below among them,
  // which the quote's own fence has to outlast.
  assert.match(entries, /\n {2}````\n {2}\n {2}Then a second run[^]*\n {2}```\n {2}````\n/);
  assert.doesNotMatch(entries, /```diff/);
});

test('a comment on a list item and on code counts their own lines', async () => {
  const p = await annotatedPage(WITH_PLAN);
  const section = p.document.querySelector('.dv-section');
  await p.selectText(section, 'macOS debug');
  p.comment('one');
  await p.selectText(section, '--verify');
  p.comment('two');
  const [first, second] = p.window.mdvReviewComments();
  assert.deepEqual(plain(first.anchor), { file: '(section:test-plan)', line: 4 });
  assert.deepEqual(plain(second.anchor), { file: '(section:test-plan)', line: 10 });
});

test('a comment across lines of a section names them as a range', async () => {
  const p = await annotatedPage(WITH_PLAN);
  const items = p.document.querySelectorAll('.dv-section li');
  await p.selectAcross(items[0], items[1]);
  p.comment('both');
  assert.deepEqual(plain(p.window.mdvReviewComments()[0].anchor), { file: '(section:test-plan)', line: [3, 4] });
});

test('a comment on the commit message is anchored to (commit) and its lines', async () => {
  const p = await annotatedPage({});
  const lines = p.document.querySelectorAll('.dv-msg-table .dv-text');
  await p.selectText(lines[2], 'time out');
  p.comment('how long?');
  await p.selectAcross(lines[0], lines[2]);
  p.comment('all of it');
  const [one, two] = p.window.mdvReviewComments();
  assert.deepEqual(plain(one.anchor), { file: '(commit)', line: 3 });
  assert.deepEqual(plain(two.anchor), { file: '(commit)', line: [1, 3] });
  assert.notEqual(one.id, two.id);
  assert.match(p.window.mdvReviewEntries([one]), /^- the commit message, line 3 — "time out"/);
});

test('a comment on a file names the file, its line and the side', async () => {
  const p = await annotatedPage({});
  const added = p.document.querySelector('.dv-line-add .dv-text');
  await p.selectText(added, 'three');
  p.comment('why three');
  const removed = p.document.querySelector('.dv-line-del .dv-text');
  await p.selectText(removed, 'two');
  p.comment('why not two');
  const [add, del] = p.window.mdvReviewComments();
  assert.deepEqual(plain(add.anchor), { file: 'a.js', line: 2, side: 'new' });
  assert.deepEqual(plain(del.anchor), { file: 'a.js', line: 2, side: 'old' });
});

test('comments on the message work in a stack page, which carries the same review scripts', async () => {
  // jsdom runs no script in a frame made from srcdoc, so the commit's page
  // is taken out of the stack and loaded as the frame would load it.
  const html = await buildStackPage([{ sha: SHA, label: 'aaaa', source: COMMIT }], {
    title: 't',
    where: '/r',
    annotations: { commits: {} },
  });
  const outer = new JSDOM(html).window.document;
  const page = JSON.parse(outer.getElementById('sv-page-0').textContent);
  const { window } = new JSDOM(page, { runScripts: 'dangerously', url: 'http://127.0.0.1/' });
  const { hands } = await import('./helpers/page.js');
  const p = hands(window);
  await p.selectText(p.document.querySelector('.dv-line-msg .dv-text'), 'Wait for the popup');
  p.comment('wait how?');
  const [comment] = window.mdvReviewComments();
  assert.deepEqual(plain(comment.anchor), { file: '(commit)', line: 1 });
  assert.match(window.mdvReviewEntries([comment]), /the commit message, line 1/);
});
