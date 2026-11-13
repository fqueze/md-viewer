/**
 * The stack review page: one commit's review page per commit, in a single tab.
 *
 * Each commit is the diff page diff-viewer serves, unchanged, and is shown in
 * an iframe. That is what keeps a comment on one commit a comment on that
 * commit: the review scripts hold their comments in the page they run in, and
 * the copied prompt names the page's commit, so a frame per commit gives each
 * its own review without the scripts having to know they are one of several.
 *
 * The pages are carried inside the outer document rather than fetched, since
 * the process that built this page leaves shortly after serving it. They sit
 * in JSON script blocks and are parsed into a frame the first time the reader
 * opens that commit — a stack can be long, and parsing every diff at once
 * would make the tab slow to appear for the sake of commits not yet looked at.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDiffDocument } from './diff-page.js';
import { splitCommitMessage } from './diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(HERE, '..', 'assets');

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/**
 * JSON safe to put inside a `<script>` element. The parser ends a script at
 * the first `</script` it sees, and treats `<!--` as the start of a region
 * where it looks for one differently; a document that holds whole documents
 * holds both. JSON allows `\/` and `<`, so both are escaped and the text
 * parses back to what it was.
 */
export function jsonForScript(value) {
  return JSON.stringify(value).replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--');
}

/** `+12 −3`, or a word when the commit changed nothing. */
function stats(rendered) {
  if (!rendered.files) {
    return '<span class="sv-entry-stat sv-entry-empty">no changes</span>';
  }
  return (
    `<span class="sv-entry-stat dv-stat-add">+${rendered.additions}</span>` +
    `<span class="sv-entry-stat dv-stat-del">−${rendered.deletions}</span>`
  );
}

/**
 * The files a commit changes, as a tree of the directories they sit in, the
 * way Phabricator lists a revision's paths. Each file is a button naming the
 * section of the commit's page that shows it.
 *
 * The tree is drawn flat, one row per directory or file with its depth as an
 * indent, since that is all it is ever used as. A directory holding only one
 * other directory is a step along a path rather than a level of the tree, so
 * the two share a row: `toolkit/components/promiseworker/` is one row, not
 * three nested ones with nothing else in them.
 *
 * The paths come in the order the page shows their sections, which renderDiff
 * already sorts as this tree reads, so the walk below draws them in that order.
 */
function fileTreeHtml(paths) {
  const tree = () => ({ dirs: new Map(), files: [] });
  const root = tree();
  paths.forEach(({ path: file, status }, index) => {
    const parts = file.split('/');
    const name = parts.pop();
    let dir = root;
    for (const part of parts) {
      if (!dir.dirs.has(part)) dir.dirs.set(part, tree());
      dir = dir.dirs.get(part);
    }
    dir.files.push({ name, path: file, status, index });
  });

  const rows = (dir, depth) => {
    let html = '';
    for (let [name, sub] of dir.dirs) {
      while (!sub.files.length && sub.dirs.size === 1) {
        const [[next, only]] = sub.dirs;
        name += '/' + next;
        sub = only;
      }
      html +=
        `<li class="sv-dir" style="--sv-depth: ${depth}" title="${escapeHtml(name)}/">` +
        `${escapeHtml(name)}/</li>` +
        rows(sub, depth + 1);
    }
    for (const file of dir.files) {
      html +=
        `<li><button type="button" class="sv-file sv-file-${file.status}" data-file="${file.index}" ` +
        `style="--sv-depth: ${depth}" title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</button></li>`;
    }
    return html;
  };
  return `<ul>${rows(root, 0)}</ul>`;
}

/**
 * The Phabricator revision a commit was submitted as, `D123`, from the
 * `Differential Revision:` line moz-phab adds to its message; or null.
 */
function revisionOf(message) {
  return /^Differential Revision:\s*\S*\/(D\d+)\s*$/m.exec(message)?.[1] ?? null;
}

/**
 * Build the page.
 *
 * `patches` are the commits oldest first, each with the `source` `git show`
 * wrote for it and the `label` the reader knows it by. `title` names the stack
 * — the revset as it was typed — and `where` says which repository.
 */
export async function buildStackPage(patches, { title, where }) {
  const [base, stackCss, stackJs] = await Promise.all([
    fsp.readFile(path.join(ASSETS, 'style.css'), 'utf8'),
    fsp.readFile(path.join(ASSETS, 'stack.css'), 'utf8'),
    fsp.readFile(path.join(ASSETS, 'stack.js'), 'utf8'),
  ]);

  const pages = [];
  for (const patch of patches) {
    // The subject is wanted before the page is built, since the page shows it
    // in its heading; the same parser the renderer uses finds it.
    const message = splitCommitMessage(patch.source).message?.body ?? '';
    const subject = message.split('\n')[0];
    const { html, rendered } = await buildDiffDocument(patch.source, {
      title: patch.label,
      subtitle: subject || null,
      commit: patch.sha,
    });
    pages.push({ ...patch, subject, revision: revisionOf(message), html, rendered });
  }

  const entries = pages
    .map(
      (page, i) =>
        `<li><button type="button" class="sv-entry" data-index="${i}">` +
        `<span class="sv-entry-n">${i + 1}</span>` +
        // The revision shares the id's place, so that a commit without one
        // leaves no empty column behind.
        '<span class="sv-entry-id">' +
        (page.revision ? `<span class="sv-entry-rev">${page.revision}</span> ` : '') +
        `${escapeHtml(page.label)}</span>` +
        `<span class="sv-entry-subject">${escapeHtml(page.subject || '(no description)')}</span>` +
        `<span class="sv-entry-stats">${stats(page.rendered)}</span>` +
        `<span class="sv-entry-comments" hidden></span>` +
        '</button></li>',
    )
    .join('\n');

  // One list of files per commit, and only the current commit's is shown.
  const fileLists = pages
    .map(
      (page, i) =>
        `<div class="sv-files-of" data-index="${i}" hidden>` +
        (page.rendered.paths.length
          ? fileTreeHtml(page.rendered.paths)
          : '<p class="sv-files-none">No file changes.</p>') +
        '</div>',
    )
    .join('\n');

  const blocks = pages
    .map(
      (page, i) =>
        `<script type="application/json" id="sv-page-${i}">${jsonForScript(page.html)}</script>`,
    )
    .join('\n');

  const meta = pages.map((page) => ({ sha: page.sha, label: page.label, subject: page.subject }));
  const count = `${pages.length} commit${pages.length === 1 ? '' : 's'}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — ${escapeHtml(path.basename(where))}</title>
<style>
${base}
${stackCss}</style>
</head>
<body class="sv-body">
<div id="sv-root" class="sv-root" data-title="${escapeHtml(title)}">
<header class="sv-header">
<button type="button" class="sv-list-toggle" id="sv-list-toggle" title="Show or hide the list (Alt+L)" aria-label="Show or hide the list">☰</button>
<div class="sv-title"><span class="sv-title-revset">${escapeHtml(title)}</span> <span class="sv-title-where">${escapeHtml(where)}</span></div>
<span class="sv-count">${count}</span>
<div class="sv-review" id="sv-review" hidden>
<span class="sv-review-count"></span>
<button type="button" class="sv-review-copy" id="sv-review-copy">Copy all reviews</button>
</div>
</header>
<aside class="sv-list" id="sv-list">
<nav class="sv-commits" aria-label="Commits">
<ol>
${entries}
</ol>
</nav>
<div class="sv-splitter" id="sv-splitter" role="separator" aria-orientation="horizontal" title="Drag to resize, double-click to reset"></div>
<nav class="sv-files" id="sv-files" aria-label="Files in this commit">
${fileLists}
</nav>
<div class="sv-width-handle" id="sv-width-handle" role="separator" aria-orientation="vertical" title="Drag to resize, double-click to reset"></div>
</aside>
<main class="sv-pane" id="sv-pane"></main>
</div>
<script type="application/json" id="sv-meta">${jsonForScript(meta)}</script>
${blocks}
<script>
${stackJs}</script>
</body>
</html>
`;
}
