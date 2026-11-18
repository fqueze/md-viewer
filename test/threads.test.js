/**
 * Tests for earlier comments: shown as threads on the lines they were made
 * on, with the responses the program offers, read back with
 * `mdvReviewResponses()`.
 *
 *   node --test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { annotatedPage } from './helpers/page.js';

/** A value from the page's realm, as one of this realm's for comparing. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const PLAN = { id: 'test-plan', title: 'Test plan', markdown: 'Ran it.\n\n- once\n- twice' };

/** One earlier comment, open, with every response offered. */
function earlier(id, anchor, extra = {}) {
  return {
    id,
    anchor,
    author: 'smaug (Phabricator)',
    date: '2026-11-17T09:00:00Z',
    body: `About this, \`${id}\`.\n\nSecond paragraph <b>not bold</b>.`,
    state: 'open',
    responses: ['done', 'address', 'reply', 'ignore'],
    ...extra,
  };
}

async function threadPage(comments, more = {}) {
  return annotatedPage({ sections: [PLAN], comments, ...more });
}

const threadOf = (p, id) => p.document.querySelector(`.mdv-thread[data-comment="${id}"]`);

test('an earlier comment is shown after the line it was made on', async () => {
  const p = await threadPage([
    earlier('new', { file: 'a.js', line: 2, side: 'new' }),
    earlier('old', { file: 'a.js', line: 2, side: 'old' }),
    earlier('ctx', { file: 'a.js', line: [1, 3], side: 'new' }),
    earlier('msg', { file: '(commit)', line: 3 }),
    earlier('plan', { file: '(section:test-plan)', line: 4 }),
  ]);
  const lineBefore = (id) => {
    const holder = threadOf(p, id).parentElement;
    assert.ok(holder.classList.contains('mdv-threads'));
    // A context line's thread follows its row, which holds both copies.
    const before = holder.previousElementSibling;
    return before.classList.contains('dv-row-context') ? before.querySelector('.dv-line') : before;
  };
  assert.equal(lineBefore('new').querySelector('.dv-text').textContent, 'three();');
  assert.equal(lineBefore('old').querySelector('.dv-text').textContent, 'two();');
  // A range is shown after its last line.
  assert.equal(lineBefore('ctx').querySelector('.dv-text').textContent, 'four();');
  assert.equal(lineBefore('msg').dataset.msgLine, '3');
  assert.equal(lineBefore('plan').tagName, 'UL');

  // Side by side, a thread takes the row after its line, across both columns.
  const holder = threadOf(p, 'new').parentElement;
  assert.equal(holder.style.getPropertyValue('--dv-row'), '1');
  // Its words are not the commit's: comments on the page do not anchor in them.
  assert.ok(holder.classList.contains('mdv-aside'));
});

test("a thread shows who wrote it, when, and its text, with the commenter's HTML as text", async () => {
  const p = await threadPage([
    earlier('one', { file: 'a.js', line: 2, side: 'new' }, { sourceUrl: 'https://phabricator.example/D1' }),
  ]);
  const thread = threadOf(p, 'one');
  assert.equal(thread.querySelector('.mdv-thread-author').textContent, 'smaug (Phabricator)');
  assert.match(thread.querySelector('.mdv-thread-date').textContent, /Nov 17/);
  assert.equal(thread.querySelector('.mdv-thread-source').href, 'https://phabricator.example/D1');
  const body = thread.querySelector('.mdv-thread-body');
  assert.equal(body.querySelectorAll('p').length, 2);
  assert.equal(body.querySelector('code').textContent, 'one');
  assert.equal(body.querySelector('b'), null);
  assert.match(body.textContent, /<b>not bold<\/b>/);
});

test('a comment on no line shown here is in a box between the message and the files, grouped by where it was', async () => {
  const p = await threadPage([
    earlier('outdated', { file: 'a.js', line: 40, side: 'new' }, { outdated: true }),
    earlier('unshown', { file: 'a.js', line: 40, side: 'new' }),
    earlier('gone', { file: 'gone.js', line: 3, side: 'new' }, { outdated: true }),
    earlier('msg', { file: '(commit)', line: 9 }, { outdated: true }),
  ]);
  const box = p.document.querySelector('.mdv-earlier');
  assert.ok(box.previousElementSibling.classList.contains('dv-message'));
  assert.ok(box.nextElementSibling.classList.contains('dv-files'));
  // One entry for one author's comments made together, its head saying who and when, as Phabricator's timeline.
  const entries = box.querySelectorAll('.mdv-earlier-entry');
  assert.equal(entries.length, 1);
  assert.match(entries[0].querySelector('.mdv-earlier-head').textContent, /^smaug \(Phabricator\) added inline comments\.Nov 17/);
  assert.equal(threadOf(p, 'outdated').querySelector('.mdv-thread-author'), null, 'not on each comment');
  const groups = [...box.querySelectorAll('.mdv-earlier-group')].map((g) => [
    g.querySelector('.mdv-earlier-where').textContent,
    [...g.querySelectorAll('.mdv-thread')].map((t) => t.dataset.comment),
  ]);
  assert.deepEqual(groups, [
    ['a.js', ['outdated', 'unshown']],
    ['gone.js', ['gone']],
    ['Commit message', ['msg']],
  ]);
  // The line in a gutter, as Phabricator's timeline has it.
  const gutter = (id) => threadOf(p, id).querySelector('.mdv-thread-line');
  assert.deepEqual([gutter('outdated').textContent, gutter('outdated').title], ['↪ 40', 'line 40 of the version it was made on']);
  assert.deepEqual([gutter('unshown').textContent, gutter('unshown').title], ['↪ 40', 'line 40, not shown in this diff']);
  assert.ok(threadOf(p, 'outdated').classList.contains('mdv-thread-outdated'));
});

test('a comment that is not open shows its text greyed, and its state on the right: Done as a checkbox where offered', async () => {
  const p = await threadPage([
    earlier('done', { file: 'a.js', line: 2, side: 'new' }, { state: 'done' }),
    earlier('ignored', { file: 'a.js', line: 2, side: 'new' }, { state: 'ignored' }),
    earlier('bot', { file: 'a.js', line: 2, side: 'new' }, { state: 'done', responses: ['reply'] }),
  ]);
  const done = threadOf(p, 'done');
  assert.ok(done.querySelector('.mdv-thread-end .mdv-respond-done input').checked);
  assert.equal(done.querySelector('.mdv-thread-state'), null);
  assert.match(done.querySelector('.mdv-thread-body').textContent, /About this, done\./);
  assert.equal(threadOf(p, 'ignored').querySelector('.mdv-thread-end .mdv-respond-done input').checked, false);
  assert.equal(threadOf(p, 'ignored').querySelector('.mdv-respond-ignore').getAttribute('aria-pressed'), 'false', "the program's state, not a response of the reader's");
  // Not the reader's to mark done: the state as text.
  assert.equal(threadOf(p, 'bot').querySelector('.mdv-thread-end .mdv-thread-state').textContent, '✓ Done');
  assert.equal(threadOf(p, 'bot').querySelector('.mdv-respond-done'), null);
});

test('a comment the program says is addressed says so, and Address asks for it again', async () => {
  const p = await threadPage([earlier('fixed', { file: 'a.js', line: 2, side: 'new' }, { state: 'addressed', responses: ['address', 'ignore'] })]);
  const thread = threadOf(p, 'fixed');
  assert.equal(thread.querySelector('.mdv-thread-state').textContent, '✓ Addressed');
  assert.equal(thread.querySelector('.mdv-respond-address').getAttribute('aria-pressed'), 'false');
  thread.querySelector('.mdv-respond-address').click();
  assert.equal(JSON.stringify(p.window.mdvReviewResponses()), JSON.stringify([{ id: 'fixed', response: 'address' }]));
  assert.equal(threadOf(p, 'fixed').querySelector('.mdv-thread-state').textContent, 'To address');
});

test('only the responses offered are shown', async () => {
  const p = await threadPage([earlier('one', { file: 'a.js', line: 2 }, { responses: ['done'] })]);
  const controls = [...threadOf(p, 'one').querySelectorAll('.mdv-respond')].map((c) => c.dataset.respond ?? 'done');
  assert.deepEqual(controls, ['done']);
});

test('the responses are read back, the latest per comment', async () => {
  const p = await threadPage([
    earlier('a', { file: 'a.js', line: 2 }),
    earlier('b', { file: 'a.js', line: 1 }),
    earlier('c', { file: 'a.js', line: 3 }, { state: 'done' }),
  ]);
  const { window } = p;
  assert.deepEqual(plain(window.mdvReviewResponses()), []);

  const click = (id, kind) => threadOf(p, id).querySelector(`.mdv-respond-${kind}`).click();
  const check = (id, on) => {
    const box = threadOf(p, id).querySelector('.mdv-respond-done input');
    box.checked = on;
    box.dispatchEvent(new window.Event('change', { bubbles: true }));
  };

  click('a', 'address');
  assert.equal(threadOf(p, 'a').querySelector('.mdv-respond-address').getAttribute('aria-pressed'), 'true');
  click('a', 'ignore');
  assert.equal(threadOf(p, 'a').querySelector('.mdv-respond-address').getAttribute('aria-pressed'), 'false');
  check('b', true);
  check('c', false);
  assert.deepEqual(plain(window.mdvReviewResponses()), [
    { id: 'a', response: 'ignore' },
    { id: 'b', response: 'done' },
    // It came done: unchecking it reopens it.
    { id: 'c', response: 'reopen' },
  ]);

  // Taking a response back leaves the comment as it came.
  click('a', 'ignore');
  check('b', false);
  check('c', true);
  assert.deepEqual(plain(window.mdvReviewResponses()), []);
});

test("a reply opens with the program's draft, and its text goes with whatever is chosen after", async () => {
  const p = await threadPage([
    earlier('a', { file: 'a.js', line: 2 }, { draftReply: 'Because the databases outlive the test.' }),
  ]);
  const { window } = p;
  // Shown before Reply is clicked, as it would be sent.
  assert.equal(threadOf(p, 'a').querySelector('.mdv-thread-draft-body').textContent.trim(), 'Because the databases outlive the test.');
  threadOf(p, 'a').querySelector('.mdv-respond-reply').click();
  assert.equal(threadOf(p, 'a').querySelector('.mdv-thread-draft'), null, 'its text box takes its place');
  const area = threadOf(p, 'a').querySelector('.mdv-reply');
  assert.equal(area.value, 'Because the databases outlive the test.');
  assert.deepEqual(plain(window.mdvReviewResponses()), [
    { id: 'a', response: 'reply', text: 'Because the databases outlive the test.' },
  ]);

  area.value = 'Because they outlive it.';
  area.dispatchEvent(new window.Event('input', { bubbles: true }));
  const box = threadOf(p, 'a').querySelector('.mdv-respond-done input');
  box.checked = true;
  box.dispatchEvent(new window.Event('change', { bubbles: true }));
  assert.deepEqual(plain(window.mdvReviewResponses()), [
    { id: 'a', response: 'done', text: 'Because they outlive it.' },
  ]);
  // Redrawn with the reply still open.
  assert.equal(threadOf(p, 'a').querySelector('.mdv-reply').value, 'Because they outlive it.');

  // Emptied, the reply is no longer part of it.
  const again = threadOf(p, 'a').querySelector('.mdv-reply');
  again.value = '  ';
  again.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.deepEqual(plain(window.mdvReviewResponses()), [{ id: 'a', response: 'done' }]);
});

test('mdvSetAnnotations redraws the threads, keeping the responses made', async () => {
  const p = await threadPage([earlier('a', { file: 'a.js', line: 2 })]);
  threadOf(p, 'a').querySelector('.mdv-respond-address').click();
  p.window.mdvSetAnnotations(p.document.getElementById('mdv-root').dataset.commit, {
    sections: [PLAN],
    comments: [earlier('a', { file: 'a.js', line: 1 }), earlier('b', { file: '(commit)', line: 1 })],
  });
  assert.equal(p.document.querySelectorAll('.mdv-thread').length, 2);
  assert.equal(p.document.querySelectorAll('.mdv-threads').length, 2, 'the old holders went');
  assert.equal(threadOf(p, 'a').querySelector('.mdv-respond-address').getAttribute('aria-pressed'), 'true');
  assert.deepEqual(plain(p.window.mdvReviewResponses()), [{ id: 'a', response: 'address' }]);
});

test('typing in a reply does not start a comment on the selection', async () => {
  const p = await threadPage([earlier('a', { file: 'a.js', line: 2 })]);
  await p.selectText(p.document.querySelector('.dv-line-add .dv-text'), 'three');
  assert.ok(p.document.querySelector('.mdv-review-box'));
  threadOf(p, 'a').querySelector('.mdv-respond-reply').click();
  const area = threadOf(p, 'a').querySelector('.mdv-reply');
  area.dispatchEvent(new p.window.KeyboardEvent('keydown', { key: 'x', bubbles: true }));
  assert.notEqual(p.document.activeElement, p.document.querySelector('.mdv-review-box textarea'));
});

test('a comment on the commit as a whole is shown without saying where', async () => {
  const p = await threadPage([earlier('general', { file: '(commit)' })]);
  assert.equal(threadOf(p, 'general').querySelector('.mdv-thread-line'), null);
});

test('Reply is a link in the head, and double-clicking the comment opens the reply too', async () => {
  const p = await threadPage([earlier('one', { file: 'a.js', line: 2, side: 'new' }, { responses: ['address', 'reply'] })]);
  const thread = threadOf(p, 'one');
  assert.ok(thread.querySelector('.mdv-thread-head .mdv-respond-reply'));
  assert.equal(thread.querySelector('.mdv-thread-controls .mdv-respond-reply'), null);
  thread.querySelector('.mdv-thread-body').dispatchEvent(new p.window.MouseEvent('dblclick', { bubbles: true }));
  assert.ok(threadOf(p, 'one').querySelector('.mdv-thread-controls .mdv-reply'));
});

test("a comment's replies are shown under it, each saying who and when", async () => {
  const p = await threadPage([earlier('asked', { file: 'a.js', line: 2, side: 'new' }, { replies: [{ author: 'its author', date: '2026-11-18T10:00:00Z', body: 'Because **reasons**.' }] })]);
  const reply = threadOf(p, 'asked').querySelector('.mdv-thread-reply');
  assert.equal(reply.querySelector('.mdv-thread-author').textContent, 'its author');
  assert.match(reply.querySelector('.mdv-thread-date').textContent, /Nov 18/);
  assert.equal(reply.querySelector('.mdv-thread-reply-body strong').textContent, 'reasons');
});

test("a comment's holder says which version it is on, so side by side puts it under that version", async () => {
  const p = await threadPage([
    earlier('new', { file: 'a.js', line: 2, side: 'new' }),
    earlier('old', { file: 'a.js', line: 2, side: 'old' }),
  ]);
  assert.equal(threadOf(p, 'new').parentElement.dataset.side, 'new');
  assert.equal(threadOf(p, 'old').parentElement.dataset.side, 'old');
});

test("the history is a line per action among the earlier comments' entries, by date", async () => {
  const p = await threadPage([earlier('outdated', { file: 'a.js', line: 40, side: 'new' }, { outdated: true, date: '2026-11-17T09:00:00Z' })], {
    history: [
      { date: '2026-11-18T10:00:00Z', author: 'you', action: 'approved this version.', kind: 'accept' },
      { date: '2026-11-16T10:00:00Z', author: 'you', action: 'sent 2 comments back to its author.', kind: 'request-changes' },
    ],
  });
  const order = [...p.document.querySelector('.mdv-earlier').children].map((x) => x.className.split(' ')[0] + ':' + x.textContent.slice(0, 20));
  assert.deepEqual(order.map((x) => x.split(':')[0]), ['mdv-history', 'mdv-earlier-entry', 'mdv-history']);
  assert.ok(p.document.querySelector('.mdv-history-accept').textContent.startsWith('you approved this version.'));
});

test('an outdated comment on a line shown here is on it, saying so, with the lines it was made on', async () => {
  const p = await threadPage([earlier('older', { file: 'a.js', line: 2, side: 'new' }, { outdated: true, context: [{ n: 1, text: 'one();', here: false }, { n: 2, text: 'deux();', here: true }] })]);
  const thread = threadOf(p, 'older');
  assert.equal(p.document.querySelector('.mdv-earlier'), null, 'not among the earlier comments');
  assert.match(thread.querySelector('.mdv-thread-older').textContent, /earlier version/);
  assert.deepEqual([...thread.querySelectorAll('.mdv-thread-context-here')].map((l) => l.textContent), ['2deux();']);
});
