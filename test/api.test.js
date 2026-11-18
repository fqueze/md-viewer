/**
 * Tests for the API a program serving the review uses: a stack page that
 * fetches each commit's page, and those pages, linking their assets.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { assetText, buildCommitPage, buildStackShell, commitSummary } from '../lib/api.js';
import { COMMIT, SHA } from './helpers/page.js';

const assetUrl = (name) => `/assets/v1/${name}`;

test('the stack page lists the commits, fetches their pages from pageUrl, and opens on the one the program says', async () => {
  const commits = [
    { sha: SHA, label: 'one', source: COMMIT },
    { sha: 'b'.repeat(40), label: 'two', source: COMMIT },
  ].map(commitSummary);
  assert.equal(commits[0].subject, 'Bug XXXXXXX - Wait for the popup, r=me.');
  assert.ok(commits[0].paths.length);
  const html = await buildStackShell(commits, {
    title: 't',
    where: '/repo',
    annotations: { open: 'b'.repeat(12), commits: {} },
    pageUrl: (i) => `/page/${i}`,
    assetUrl,
  });
  const { document } = new JSDOM(html).window;
  const meta = JSON.parse(document.getElementById('sv-meta').textContent);
  assert.deepEqual(meta.map((m) => m.src), ['/page/0', '/page/1']);
  assert.equal(document.getElementById('sv-root').dataset.open, '1');
  assert.equal(document.querySelector('[id^="sv-page-"]'), null, 'no page carried');
  assert.deepEqual([...document.querySelectorAll('link')].map((l) => l.getAttribute('href')), ['/assets/v1/style.css', '/assets/v1/stack.css']);
  assert.equal(document.querySelectorAll('.sv-entry').length, 2);
});

test("a commit's page links its assets, highlight.js's for its languages, and carries its files' new versions", async () => {
  const html = await buildCommitPage(
    { sha: SHA, label: 'one', source: COMMIT, versions: { 'a.js': { newOid: 'n'.repeat(40), newText: 'one\ntwo\nthree\n' } } },
    { annotated: true, annotation: {}, assetUrl },
  );
  const { document } = new JSDOM(html).window;
  const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
  assert.ok(scripts.includes('/assets/v1/hljs/core.js'));
  assert.ok(scripts.includes('/assets/v1/hljs/javascript.js'));
  assert.ok(scripts.indexOf('/assets/v1/hljs/core.js') < scripts.indexOf('/assets/v1/colour.js'));
  assert.equal(document.querySelector('style'), null);
  assert.ok(document.getElementById('mdv-blob-' + 'n'.repeat(40)));
  assert.match(await assetText('hljs/javascript.js'), /registerLanguage\("javascript"/);
  await assert.rejects(assetText('../package.json'));
});
