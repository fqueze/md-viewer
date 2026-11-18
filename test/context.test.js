/**
 * Tests for more context: each changed file's new version carried in the
 * page, the unchanged lines between and around the hunks shown from it on
 * request, and the hunks highlighted from the whole file.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { renderDiff } from '../lib/diff.js';
import { buildStackPage } from '../lib/stack-page.js';
import { openStack, readFileVersions, readStack } from '../lib/stack.js';
import { SHA, annotatedPage } from './helpers/page.js';

/**
 * A 60-line file: a block comment on lines 1 to 11, then a statement a line.
 * The change edits line 8, inside the comment, and line 30.
 */
const before = [
  '/*',
  ...Array.from({ length: 9 }, (_, i) => `  let comment${i + 2} = "inside";`),
  ' */',
  ...Array.from({ length: 49 }, (_, i) => `let v${i + 12} = ${i + 12};`),
];
const after = before.map((line, i) =>
  i === 7 ? '  let comment8 = "changed";' : i === 29 ? 'let v30 = 300;' : line,
);
const OLD = before.join('\n') + '\n';
const NEW = after.join('\n') + '\n';

/** The hunk of `lines` lines starting at `start`, with line `changed` edited. */
function hunk(start, changed) {
  const out = [`@@ -${start},7 +${start},7 @@`];
  for (let n = start; n < start + 7; n++) {
    if (n === changed) out.push(`-${before[n - 1]}`, `+${after[n - 1]}`);
    else out.push(` ${before[n - 1]}`);
  }
  return out.join('\n');
}

const SOURCE =
  `commit ${SHA}\nAuthor: A <a@b>\nDate:   Tue Sep 16 12:00:00 2026 +0200\n\n    Change two lines\n\n` +
  `diff --git a/f.js b/f.js\n--- a/f.js\n+++ b/f.js\n${hunk(5, 8)}\n${hunk(27, 30)}\n`;

const VERSIONS = { 'f.js': { newOid: 'n'.repeat(40), newText: NEW } };

test('a file whose new version is known gets a row for each gap, numbered in both files', () => {
  const rendered = renderDiff(SOURCE, { versions: VERSIONS });
  const { document } = new JSDOM(rendered.html).window;
  const section = document.querySelector('.dv-files .dv-file');
  assert.equal(section.dataset.blob, 'n'.repeat(40));
  const gaps = [...section.querySelectorAll('.dv-row-expand')].map((row) => [
    row.dataset.from,
    row.dataset.to,
    row.dataset.delta,
    row.querySelector('.dv-hunk-text').title,
  ]);
  assert.deepEqual(gaps, [
    ['1', '4', '0', '@@ -5,7 +5,7 @@'],
    ['12', '26', '0', '@@ -27,7 +27,7 @@'],
    ['34', '60', '0', ''],
  ]);
  // As text: the page colours it.
  assert.equal(rendered.blobs.get('n'.repeat(40)).text.length, 60);
});

/** Whether each of the first lines drawn opens in a comment's colour, once the page has coloured them. */
async function commented(versions) {
  const p = await annotatedPage({}, SOURCE, { page: { versions } });
  await p.coloured();
  return [...p.document.querySelectorAll('.dv-files .dv-line:not(.dv-line-mirror)')]
    .slice(0, 9)
    .map((line) => Boolean(line.querySelector('.dv-text > .hljs-comment')));
}

test('the hunks are coloured from the whole file, both versions, so a comment opened above one colours it', async () => {
  // From the hunk alone, the lines inside the comment read as code.
  assert.ok((await commented(null)).every((c) => !c));
  // From the file, every line of the first hunk, to line 11, the deletion
  // included, is comment, and the second hunk's first is code.
  assert.deepEqual(await commented(VERSIONS), [true, true, true, true, true, true, true, true, false]);
});

test('a hunk that does not fit the file it is said to be in is coloured from the hunk', async () => {
  const wrong = { 'f.js': { newOid: 'x'.repeat(40), newText: 'something else\n' } };
  assert.ok((await commented(wrong)).every((c) => !c));
});

async function contextPage(annotation = {}, options = {}) {
  return annotatedPage(annotation, SOURCE, { ...options, page: { versions: VERSIONS } });
}

const numbers = (row) => [...row.querySelectorAll('.dv-line:not(.dv-line-mirror) .dv-num')].map((n) => n.textContent);

test('the buttons show twenty more lines either side, or all, numbered in both files', async () => {
  const p = await contextPage();
  const { document } = p;
  const rows = () => [...document.querySelectorAll('.dv-row-expand')];
  const labels = (row) => [...row.querySelectorAll('.dv-expand')].map((b) => b.textContent);
  // Before the first hunk four lines; between them fifteen; after, 27.
  assert.deepEqual(rows().map(labels), [
    ['Show 4 lines'],
    ['Show 15 lines'],
    ['▲ 20 more lines', 'Show all 27 lines', 'Show last 20 lines'],
  ]);
  assert.ok(document.getElementById('mdv-blob-' + 'n'.repeat(40)), 'the page carries the file');

  // Twenty below the last hunk: lines 34 to 53, and a row for the rest.
  rows()[2].querySelector('.dv-expand-start').click();
  const shown = [...document.querySelectorAll('.dv-row-expanded')];
  assert.equal(shown.length, 20);
  assert.deepEqual(numbers(shown[0]), ['34', '34']);
  assert.equal(shown[0].querySelector('.dv-text').textContent, 'let v34 = 34;');
  assert.deepEqual(rows().map((r) => [r.dataset.from, r.dataset.to]).at(-1), ['54', '60']);

  // All of the middle gap; its header goes with it.
  rows()[1].querySelector('.dv-expand-all').click();
  assert.equal(document.querySelectorAll('.dv-row-expanded').length, 35);
  assert.ok(!document.body.textContent.includes('@@ -27,7 +27,7 @@'));
  // The comment's colours come from the whole file.
  rows()[0].querySelector('.dv-expand-all').click();
  const first = document.querySelector('.dv-row-expanded');
  assert.deepEqual(numbers(first), ['1', '1']);
  assert.ok(first.querySelector('.dv-text .hljs-comment'));
});

test('old line numbers are the new ones moved by what the changes above added', async () => {
  // Line 8 now becomes two lines, so everything below is one further down.
  const grown = SOURCE.replace(
    '+  let comment8 = "changed";',
    '+  let comment8 = "changed";\n+  let extra = 1;',
  ).replace('@@ -5,7 +5,7 @@', '@@ -5,7 +5,8 @@').replace('@@ -27,7 +27,7 @@', '@@ -27,7 +28,7 @@');
  const lines = [...after];
  lines.splice(8, 0, '  let extra = 1;');
  const versions = { 'f.js': { newOid: 'g'.repeat(40), newText: lines.join('\n') + '\n' } };
  const p = await annotatedPage({}, grown, { page: { versions } });
  const middle = p.document.querySelectorAll('.dv-row-expand')[1];
  assert.deepEqual([middle.dataset.from, middle.dataset.to, middle.dataset.delta], ['13', '27', '-1']);
  middle.querySelector('.dv-expand-all').click();
  assert.deepEqual(numbers(p.document.querySelector('.dv-row-expanded')), ['12', '13']);
});

test("an earlier comment on a line the context leaves out is shown on it", async () => {
  const p = await contextPage({
    comments: [
      { id: 'e', anchor: { file: 'f.js', line: 20, side: 'new' }, author: 'a', body: 'here', state: 'open' },
      { id: 'o', anchor: { file: 'f.js', line: 45, side: 'old' }, author: 'a', body: 'old', state: 'open' },
    ],
  });
  for (const [id, n] of [['e', '20'], ['o', '45']]) {
    const holder = p.document.querySelector(`.mdv-thread[data-comment="${id}"]`).parentElement;
    const row = holder.previousElementSibling;
    assert.ok(row.classList.contains('dv-row-expanded'), id);
    assert.equal(row.querySelector('.dv-line').dataset.line, n);
    assert.equal(p.document.querySelector(`.mdv-thread[data-comment="${id}"] .mdv-thread-line`), null);
  }
  // A few lines either side came with it.
  assert.equal(p.document.querySelectorAll('.dv-row-expanded').length, 14);
});

test('a draft on a line shown from the file comes back on it', async () => {
  const first = await contextPage();
  first.document.querySelectorAll('.dv-row-expand')[1].querySelector('.dv-expand-all').click();
  const line = [...first.document.querySelectorAll('.dv-row-expanded .dv-text')].find(
    (t) => t.textContent === 'let v20 = 20;',
  );
  await first.selectText(line, 'v20');
  first.comment('on an expanded line');
  const [comment] = first.window.mdvReviewComments();
  assert.equal(JSON.stringify(comment.anchor), '{"file":"f.js","line":20,"side":"new"}');

  const storage = { ...first.window.localStorage };
  const again = await contextPage({}, { storage });
  const mark = again.document.querySelector(`mark[data-comment-id="${comment.id}"]`);
  assert.ok(mark, 'highlighted again, its line shown again');
  assert.equal(mark.closest('.dv-line').dataset.line, '20');
});

// ---------------------------------------------------------------------------
// Reading the versions, and carrying them
// ---------------------------------------------------------------------------

test("the stack carries each file version once, and every commit's page finds it there", async () => {
  const second = SOURCE.replace(SHA, '2'.repeat(40));
  const patches = [
    { sha: SHA, label: 'a', source: SOURCE, versions: VERSIONS },
    { sha: '2'.repeat(40), label: 'b', source: second, versions: VERSIONS },
  ];
  const html = await buildStackPage(patches, { title: 't', where: '/r' });
  assert.equal(html.split(`id="mdv-blob-${'n'.repeat(40)}"`).length, 2, 'once');
  const { document } = new JSDOM(html).window;
  const page = JSON.parse(document.getElementById('sv-page-0').textContent);
  assert.ok(!page.includes('id="mdv-blob-'), "not in the commit's own page");
  assert.ok(page.includes(`data-blob="${'n'.repeat(40)}"`));
});

test('the versions are read from git, but not for a deleted, binary or very large file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdv-context-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' };
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
  git('init', '-q', '-b', 'main');
  const write = (name, content) => fs.writeFileSync(path.join(dir, name), content);
  write('kept.js', OLD);
  write('gone.js', 'x\n');
  write('big.txt', 'a\n');
  write('bin.dat', Buffer.from([0, 1, 2, 10]));
  git('add', '.');
  git('commit', '-qm', 'base');
  write('kept.js', NEW);
  fs.rmSync(path.join(dir, 'gone.js'));
  write('big.txt', 'b\n'.repeat(600 * 1024));
  write('bin.dat', Buffer.from([0, 1, 3, 10]));
  git('add', '-A');
  git('commit', '-qm', 'change');
  const sha = git('rev-parse', 'HEAD').trim();

  const stack = await openStack({ root: dir, kind: 'git' });
  const patches = await readStack(stack, [{ sha, label: 'x' }]);
  const [versions] = await readFileVersions(stack, patches);
  assert.deepEqual(Object.keys(versions), ['kept.js']);
  assert.equal(versions['kept.js'].newText, NEW);
  assert.equal(versions['kept.js'].newOid, git('rev-parse', `${sha}:kept.js`).trim());
});
