/**
 * A commit's page with an annotation, loaded and scripted, and the hands a
 * test needs to act on it as a reader would. Shared by the tests of the
 * features a program driving the viewer uses; not a test file itself.
 */

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildDiffPage } from '../../lib/diff-page.js';

export const SHA = 'e4e5d3ab4fc080e1dd469d9972b566224c4df19c';

export const COMMIT = `commit ${SHA}
Author: A Reviewer <nobody@example.com>
Date:   Tue Sep 16 12:00:00 2026 +0200

    Bug XXXXXXX - Wait for the popup, r=me.

    It used to time out, see bug 1234567.

diff --git a/a.js b/a.js
--- a/a.js
+++ b/a.js
@@ -1,3 +1,3 @@
 one();
-two();
+three();
 four();
`;

export const ANNOTATION = {
  status: { kind: 'unreviewed', label: 'Not reviewed' },
  titleLinks: [
    { text: 'Bug XXXXXXX', href: 'https://bugzilla.example/enter_bug.cgi', tooltip: 'File the bug' },
    { text: 'bug 1234567', href: 'https://bugzilla.example/1234567' },
  ],
  actions: [
    { id: 'approve', label: 'Approve', kind: 'button' },
    { id: 'set-bug', label: 'Bug number', kind: 'input', placeholder: '1234567' },
  ],
};

/**
 * The page. `url` gives it an origin, which is what its localStorage is
 * kept under; `storage`, when given, is put in before the scripts run, as a
 * reload finds what the last visit left.
 */
export async function annotatedPage(
  annotation = ANNOTATION,
  source = COMMIT,
  { url = 'http://127.0.0.1/', storage = null, page = {} } = {},
) {
  const html = await buildDiffPage(source, {
    title: 't',
    commit: SHA,
    subtitle: 'Wait for the popup',
    annotated: true,
    annotation,
    ...page,
  });
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url,
    beforeParse(window) {
      if (storage) {
        for (const [key, value] of Object.entries(storage)) window.localStorage.setItem(key, value);
      }
    },
  });
  return hands(dom.window);
}

/** What a test does to a page, as a reader would. */
export function hands(window) {
  const { document } = window;

  /** Once the page has laid its syntax colours over every file. */
  const coloured = async () => {
    while (!document.documentElement.dataset.coloured) await new Promise((resolve) => window.setTimeout(resolve, 5));
  };

  /** Every text node under an element, in order. */
  const texts = (element) => {
    const out = [];
    const walker = document.createTreeWalker(element, window.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) out.push(node);
    return out;
  };

  /** Select a range, and wait for the page to open its comment box. */
  const selectRange = (range) => {
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new window.Event('selectionchange'));
    document.dispatchEvent(new window.Event('mouseup', { bubbles: true }));
    return new Promise((resolve) => window.setTimeout(resolve, 400));
  };

  return {
    coloured,
    window,
    document,
    texts,
    selectRange,
    /** Select `text` where it first appears under `element`, within one node. */
    selectText(element, text) {
      for (const node of texts(element)) {
        const at = node.textContent.indexOf(text);
        if (at === -1) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + text.length);
        return selectRange(range);
      }
      throw new Error(`no ${text}`);
    },
    /** Select from the start of one element's text to the end of another's. */
    selectAcross(from, to) {
      const first = texts(from)[0];
      const last = texts(to).at(-1);
      const range = document.createRange();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent.length);
      return selectRange(range);
    },
    /** Write a comment in the open box and save it, as Enter does. */
    comment(text) {
      const box = document.querySelector('.mdv-review-box');
      assert.ok(box, 'a comment box should be open');
      const textarea = box.querySelector('textarea');
      textarea.value = text;
      textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
      textarea.dispatchEvent(
        new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    },
  };
}
