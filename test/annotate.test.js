/**
 * Tests for annotations: what a program driving the viewer says about each
 * commit, drawn on the commit's page and in stack-viewer's list.
 *
 *   node --test
 *
 * jsdom does not run the scripts of a frame made from `srcdoc`, so a commit's
 * page is tested on its own, as diff-viewer serves it, and the stack's side
 * of the conversation against a stand-in for the frame's window.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { buildDiffPage } from '../lib/diff-page.js';
import { buildStackPage } from '../lib/stack-page.js';
import { annotationFor, readAnnotations } from '../lib/annotations.js';
import { ANNOTATION, COMMIT, SHA, annotatedPage as load } from './helpers/page.js';

const annotatedPage = async (...args) => (await load(...args)).window;

/** Every `mdv-action` the top window hears. */
function actions(window) {
  const heard = [];
  window.addEventListener('mdv-action', (event) => heard.push(event.detail));
  return heard;
}

test("the status is a badge under the message's first line", async () => {
  const window = await annotatedPage();
  const badge = window.document.querySelector('.dv-message .mdv-badge');
  assert.equal(badge.textContent, 'Not reviewed');
  assert.ok(badge.classList.contains('mdv-badge-unreviewed'));
  assert.equal(badge.parentElement.previousElementSibling.dataset.msgLine, '1');
  // Drawn as an aside, so the text review comments anchor in never sees it.
  assert.ok(badge.parentElement.classList.contains('mdv-aside'));
});

test('an action at the end goes after the files, by the comment on the whole commit', async () => {
  const window = await annotatedPage({ actions: [{ id: 'approve', label: 'Approve', kind: 'button', at: 'end' }] });
  const heard = actions(window);
  const button = window.document.querySelector('#mdv-general .mdv-action-button');
  assert.equal(button.textContent, 'Approve');
  assert.equal(window.document.querySelector('.dv-message .mdv-action-button'), null);
  button.click();
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [{ commit: SHA, id: 'approve' }]);
});

test('a title link is made of the first occurrence of its text, or of the link already there', async () => {
  const window = await annotatedPage();
  const links = [...window.document.querySelectorAll('.dv-msg-table a.mdv-title-link')];
  assert.deepEqual(
    links.map((a) => [a.textContent, a.href, a.title]),
    [
      ['Bug XXXXXXX', 'https://bugzilla.example/enter_bug.cgi', 'File the bug'],
      ['bug 1234567', 'https://bugzilla.example/1234567', ''],
    ],
  );
  // The second was the renderer's own bug link, pointed somewhere else.
  assert.ok(links[1].classList.contains('dv-bug'));
  // The message reads as it did.
  assert.equal(
    window.document.querySelector('.dv-line-msg .dv-text').textContent,
    'Bug XXXXXXX - Wait for the popup, r=me.',
  );
});

test('a button fires mdv-action in the top window, and an input fires its text on Enter', async () => {
  const window = await annotatedPage();
  const heard = actions(window);
  window.document.querySelector('.mdv-action-button').click();
  const input = window.document.querySelector('.mdv-action-input input');
  assert.equal(input.placeholder, '1234567');
  input.value = '2000001';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [
    { commit: SHA, id: 'approve' },
    { commit: SHA, id: 'set-bug', value: '2000001' },
  ]);
  assert.equal(heard[0].value, undefined);
});

test('mdvSetAnnotations redraws the commit in place, keeping what is being typed', async () => {
  const window = await annotatedPage();
  const { document } = window;
  const input = document.querySelector('.mdv-action-input input');
  input.value = '20000';
  input.focus();

  assert.equal(window.mdvSetAnnotations('0123456789', { status: { kind: 'approved', label: 'x' } }), false);
  assert.equal(document.querySelector('.mdv-badge').textContent, 'Not reviewed', 'another commit is not this one');

  const next = {
    ...ANNOTATION,
    status: { kind: 'approved', label: 'Approved' },
    titleLinks: [{ text: 'Wait for', href: 'https://example.com/w' }],
  };
  assert.equal(window.mdvSetAnnotations(SHA, next), true);
  assert.equal(document.querySelectorAll('.mdv-badge').length, 1);
  assert.equal(document.querySelector('.mdv-badge').textContent, 'Approved');
  assert.ok(document.querySelector('.mdv-badge').classList.contains('mdv-badge-approved'));
  const again = document.querySelector('.mdv-action-input input');
  assert.equal(again.value, '20000');
  assert.equal(document.activeElement, again);

  // The old links are gone, the bug link points back at the bug.
  const links = [...document.querySelectorAll('a.mdv-title-link')].map((a) => a.textContent);
  assert.deepEqual(links, ['Wait for']);
  const bug = document.querySelector('a.dv-bug');
  assert.match(bug.href, /bugzilla\.mozilla\.org.*1234567/);

  // A label shows in place of the text, until the link goes.
  window.mdvSetAnnotations(SHA, { titleLinks: [{ text: 'Wait for', href: 'https://example.com/b', label: 'Bug 2094409' }] });
  assert.equal(document.querySelector('a.mdv-title-link').textContent, 'Bug 2094409');

  window.mdvSetAnnotations(SHA, {});
  assert.equal(document.querySelector('.mdv-badge'), null);
  assert.equal(document.querySelector('.mdv-actions'), null);
  assert.match(document.querySelector('.dv-msg-table').textContent, /Wait for/, "the message's own words are back");
});

test('a link that does not go to the web is left as text', async () => {
  const window = await annotatedPage({ titleLinks: [{ text: 'Wait', href: 'javascript:alert(1)' }] });
  assert.equal(window.document.querySelector('a.mdv-title-link'), null);
});

test('a page built without annotations carries none of it', async () => {
  const html = await buildDiffPage(COMMIT, { title: 't', commit: SHA });
  assert.ok(!html.includes('mdv-annotation'));
  assert.ok(!html.includes('mdvSetAnnotations'));
});

test('a loose diff gets a bar of its own for its annotation', async () => {
  const loose = COMMIT.slice(COMMIT.indexOf('diff --git'));
  const window = await annotatedPage(ANNOTATION, loose);
  const bar = window.document.querySelector('.mdv-annot-bar');
  assert.ok(bar.querySelector('.mdv-badge'));
  assert.ok(bar.querySelector('.mdv-action-button'));
});

// ---------------------------------------------------------------------------
// The file
// ---------------------------------------------------------------------------

test('an annotations file is read, and a malformed one refused', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'mdv-annotations-'));
  const good = path.join(dir, 'good.json');
  await fsp.writeFile(good, JSON.stringify({ commits: { [SHA]: ANNOTATION } }));
  const annotations = await readAnnotations(good);
  assert.equal(annotationFor(annotations, SHA), annotations.commits[SHA]);
  assert.equal(annotationFor(annotations, SHA.slice(0, 12)), annotations.commits[SHA]);
  assert.equal(annotationFor(annotations, 'ffff'), null);

  const bad = path.join(dir, 'bad.json');
  await fsp.writeFile(bad, JSON.stringify({ commits: { [SHA]: { actions: 'approve' } } }));
  await assert.rejects(readAnnotations(bad), /"actions" that is not a list/);
  await fsp.writeFile(bad, '{');
  await assert.rejects(readAnnotations(bad), /is not JSON/);
  await fsp.writeFile(bad, '{}');
  await assert.rejects(readAnnotations(bad), /no "commits" object/);
});

// ---------------------------------------------------------------------------
// The stack
// ---------------------------------------------------------------------------

const SHA2 = '2222222222222222222222222222222222222222';

async function stackPage(title) {
  const second = COMMIT.replace(SHA, SHA2).replace('Bug XXXXXXX - Wait for the popup', 'Bug 1234567 - Tidy up');
  const patches = [
    { sha: SHA, label: 'aaaa', source: COMMIT },
    { sha: SHA2, label: 'bbbb', source: second },
  ];
  const annotations = { ...(title ? { title } : {}), commits: { [SHA]: ANNOTATION } };
  const html = await buildStackPage(patches, { title: 't', where: '/src/repo', annotations });
  const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://127.0.0.1/#1' });
  return { window: dom.window, html };
}

test("the stack's title, when the annotations give one, stands for the range and the folder", async () => {
  const { window } = await stackPage('Repeat failures');
  const header = window.document.querySelector('.sv-title');
  assert.equal(header.textContent, 'Repeat failures');
  assert.equal(header.title, 't /src/repo');
  assert.match(window.document.title, / — Repeat failures$/, "the open commit's subject, then the stack's title");
  assert.equal((await stackPage()).window.document.querySelector('.sv-title-where').textContent, '/src/repo');
});

test("the list shows each commit's status and title links", async () => {
  const { window } = await stackPage();
  const entries = window.document.querySelectorAll('.sv-entry');
  const status = entries[0].querySelector('.sv-entry-status');
  assert.equal(status.hidden, false);
  assert.equal(status.title, 'Not reviewed');
  assert.ok(status.classList.contains('sv-status-unreviewed'));
  assert.equal(entries[1].querySelector('.sv-entry-status').hidden, true);

  const link = entries[0].querySelector('.sv-entry-subject a.sv-title-link');
  assert.equal(link.textContent, 'Bug XXXXXXX');
  assert.equal(link.title, 'File the bug');
  assert.equal(entries[0].querySelector('.sv-entry-subject').textContent, 'Bug XXXXXXX - Wait for the popup, r=me.');
  // A bug number is a link in the list as in the message, whether a link was filled in or the commit said it.
  assert.match(entries[1].querySelector('.sv-entry-subject a.dv-bug').href, /show_bug\.cgi\?id=1234567$/);

  // Following it opens the link and stays on the commit being read, and says so with mdv-link.
  const opened = [];
  const followed = [];
  window.open = (href) => opened.push(href);
  window.addEventListener('mdv-link', (event) => followed.push(event.detail));
  entries[1].click();
  link.click();
  assert.deepEqual(opened, ['https://bugzilla.example/enter_bug.cgi']);
  assert.deepEqual(JSON.parse(JSON.stringify(followed)), [{ commit: SHA, text: 'Bug XXXXXXX', href: 'https://bugzilla.example/enter_bug.cgi' }]);
  assert.equal(window.location.hash, '#2');
});

test("following a title link in the commit's page fires mdv-link in the top window, and the link is followed", async () => {
  const window = await annotatedPage();
  const followed = [];
  window.addEventListener('mdv-link', (event) => followed.push(event.detail));
  const [link, bug] = window.document.querySelectorAll('.dv-msg-table a.mdv-title-link');
  let prevented = null;
  window.addEventListener('click', (event) => {
    prevented = event.defaultPrevented;
    event.preventDefault(); // jsdom would navigate
  });
  link.click();
  bug.dispatchEvent(new window.MouseEvent('auxclick', { bubbles: true, button: 1 }));
  assert.equal(prevented, false);
  assert.deepEqual(JSON.parse(JSON.stringify(followed)), [
    { commit: SHA, text: 'Bug XXXXXXX', href: 'https://bugzilla.example/enter_bug.cgi' },
    { commit: SHA, text: 'bug 1234567', href: 'https://bugzilla.example/1234567' },
  ]);
});

test("every commit's page carries the annotation script, with its own annotation or none", async () => {
  const { html } = await stackPage();
  const { document } = new JSDOM(html).window;
  const pages = [0, 1].map((i) => JSON.parse(document.getElementById(`sv-page-${i}`).textContent));
  const annotationOf = (page) =>
    JSON.parse(new JSDOM(page).window.document.getElementById('mdv-annotation').textContent);
  assert.deepEqual(annotationOf(pages[0]), ANNOTATION);
  assert.equal(annotationOf(pages[1]), null);
});

test('mdvSetAnnotations in the stack redraws the list and reaches the page, now or once it loads', async () => {
  const { window } = await stackPage();
  const { document } = window;
  const entries = document.querySelectorAll('.sv-entry');

  // The open commit's frame, standing in for its page's script.
  const frame = document.querySelector('.sv-frame');
  const calls = [];
  frame.contentWindow.mdvSetAnnotations = (sha, annotation) => calls.push([sha, annotation]);
  await new Promise((resolve) => window.setTimeout(resolve, 50));

  const approved = { status: { kind: 'approved', label: 'Approved' } };
  assert.equal(window.mdvSetAnnotations(SHA.slice(0, 10), approved), true);
  assert.equal(entries[0].querySelector('.sv-entry-status').title, 'Approved');
  assert.equal(entries[0].querySelector('a.sv-title-link'), null, 'the links went with the annotation');
  assert.deepEqual(calls, [[SHA, approved]]);

  // The second commit has no frame yet: its page hears of it when it loads.
  assert.equal(window.mdvSetAnnotations(SHA2, approved), true);
  assert.equal(entries[1].querySelector('.sv-entry-status').title, 'Approved');
  entries[1].click();
  const second = document.querySelectorAll('.sv-frame')[1];
  const later = [];
  second.contentWindow.mdvSetAnnotations = (sha, annotation) => later.push([sha, annotation]);
  await new Promise((resolve) => window.setTimeout(resolve, 50));
  assert.deepEqual(later, [[SHA2, approved]]);

  assert.equal(window.mdvSetAnnotations('ffffffff', approved), false);
});

test('a panel under the title has its link, folded details and a field firing its id', async () => {
  const window = await annotatedPage({
    status: { kind: 'unreviewed', label: 'Needs review' },
    panels: [{ id: 'bug', title: 'Bug to file', href: 'https://bugzilla.example/enter', tone: 'attention', markdown: 'Core::DOM · “It fails”', details: [{ label: 'Description', markdown: 'It **fails**.', copy: true }], input: { id: 'bug-draft', placeholder: 'Paste the bug number', button: 'Send' } }],
  });
  const heard = actions(window);
  const panel = window.document.querySelector('.mdv-panel');
  assert.ok(panel.closest('.mdv-panels').previousElementSibling.classList.contains('mdv-badge-row'));
  assert.equal(panel.querySelector('a.mdv-panel-link').href, 'https://bugzilla.example/enter');
  assert.equal(panel.querySelector('details strong').textContent, 'fails');
  const field = panel.querySelector('.mdv-panel-input input');
  field.value = ' 2000001 ';
  panel.querySelector('.mdv-panel-send').click();
  assert.deepEqual(JSON.parse(JSON.stringify(heard)), [{ commit: SHA, id: 'bug-draft', value: '2000001' }]);
  assert.equal(field.value, '');
});

test("a title link's tone draws it as what is to be done, under its label", async () => {
  const window = await annotatedPage({ titleLinks: [{ text: 'Bug XXXXXXX', href: 'https://bugzilla.example/enter', label: '⚑ Bug to file', tone: 'attention' }] });
  const a = window.document.querySelector('.dv-msg-table a.mdv-title-link');
  assert.equal(a.textContent, '⚑ Bug to file');
  assert.ok(a.classList.contains('mdv-title-link-attention'));
});
