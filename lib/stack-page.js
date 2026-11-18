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
 * A program serving the pages itself has the list fetch them instead
 * (buildStackShell), and builds each only when it is asked for.
 */

import path from 'node:path';
import { assetText, blobScripts, buildDiffDocument, jsonForScript } from './diff-page.js';
import { languagesFor, languagesOf } from './highlighter.js';
import { annotationFor } from './annotations.js';

export { jsonForScript };
import { linkBugs, splitCommitMessage } from './diff.js';

const escapeHtml = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);


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

/** What the list shows of a commit: who it is, and its size and files as the renderer (or diffSummary) counted them. */
export function summaryOf(patch, figures) {
  // The same parser the renderer uses finds the message.
  const message = splitCommitMessage(patch.source).message?.body ?? '';
  return {
    sha: patch.sha,
    label: patch.label,
    subject: message.split('\n')[0],
    revision: revisionOf(message),
    files: figures.files,
    additions: figures.additions,
    deletions: figures.deletions,
    paths: figures.paths,
  };
}

/**
 * Build the page.
 *
 * `patches` are the commits oldest first, each with the `source` `git show`
 * wrote for it and the `label` the reader knows it by, and the `versions` of
 * the files it changes when they were read (see readFileVersions). `title` names the stack
 * — the revset as it was typed — and `where` says which repository.
 *
 * `annotations`, when a program drives the page, are what it says about each
 * commit (see annotations.js). Each commit's page draws its own; this one
 * draws the status and the title links in the list as well, and is where the
 * program hands in a new annotation for a commit, which reaches its page.
 *
 * Every commit's page is in this one, to be shown once it is opened.
 */
export async function buildStackPage(patches, { title, where, annotations = null }) {
  const pages = [];
  // One copy of each file's text, for however many commits show the same
  // version of it.
  const cache = new Map();
  const blobs = new Map();
  for (const patch of patches) {
    const summary = summaryOf(patch, { files: 0, additions: 0, deletions: 0, paths: [] });
    const { html, rendered } = await buildDiffDocument(patch.source, {
      title: patch.label,
      subtitle: summary.subject || null,
      commit: patch.sha,
      embedded: true,
      annotated: Boolean(annotations),
      annotation: annotationFor(annotations, patch.sha),
      versions: patch.versions ?? null,
      cache,
    });
    for (const [oid, lines] of rendered.blobs) blobs.set(oid, lines);
    pages.push({ ...summaryOf(patch, rendered), html });
  }
  // highlight.js, once, for every commit's page to colour itself with.
  const languages = languagesFor(pages.flatMap((page) => languagesOf(page.html)));
  const hljs = languages.length
    ? (await Promise.all(['hljs/core.js', ...languages.map((id) => `hljs/${id}.js`)].map(assetText)))
        .map((js) => `<script>\n${js}</script>\n`)
        .join('')
    : '';
  const carried =
    pages.map((page, i) => `<script type="application/json" id="sv-page-${i}">${jsonForScript(page.html)}</script>`).join('\n') +
    '\n' +
    blobScripts(blobs) +
    hljs;
  return shellHtml(pages, { title, where, annotations, carried });
}

/**
 * The page for a program that serves each commit's page itself (see
 * api.js): the list of `commits`, each a commitSummary, and a frame per
 * commit loaded from `pageUrl(i)` once it is opened, the others after it, one
 * at a time. `assetUrl` names where its stylesheets and scripts are served.
 */
export async function buildStackShell(commits, { title, where, annotations = null, pageUrl, assetUrl }) {
  return shellHtml(
    commits.map((commit, i) => ({ ...commit, src: pageUrl(i) })),
    { title, where, annotations, carried: '', assetUrl },
  );
}

async function shellHtml(pages, { title, where, annotations, carried, assetUrl = null }) {
  const style = async (name) =>
    assetUrl ? `<link rel="stylesheet" href="${escapeHtml(assetUrl(name))}">` : `<style>\n${await assetText(name)}</style>`;
  const script = async (name) =>
    assetUrl ? `<script src="${escapeHtml(assetUrl(name))}"></script>` : `<script>\n${await assetText(name)}</script>`;

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
        `<span class="sv-entry-subject">${linkBugs(escapeHtml(page.subject || '(no description)'))}</span>` +
        `<span class="sv-entry-stats">${stats(page)}</span>` +
        `<span class="sv-entry-comments" hidden></span>` +
        // Drawn by stack.js from the annotation, which can change while the
        // page is open.
        `<span class="sv-entry-status" hidden></span>` +
        '</button></li>',
    )
    .join('\n');

  // One list of files per commit, and only the current commit's is shown.
  const fileLists = pages
    .map(
      (page, i) =>
        `<div class="sv-files-of" data-index="${i}" hidden>` +
        (page.paths.length
          ? fileTreeHtml(page.paths)
          : '<p class="sv-files-none">No file changes.</p>') +
        '</div>',
    )
    .join('\n');

  // The list draws only the status and the title links of an annotation;
  // the rest is the commit page's.
  const meta = pages.map((page) => {
    const entry = { sha: page.sha, label: page.label, subject: page.subject };
    // Where the commit's page is fetched from, for a page that does not carry it.
    if (page.src) entry.src = page.src;
    const annotation = annotationFor(annotations, page.sha);
    if (annotation) {
      entry.annotation = { status: annotation.status, titleLinks: annotation.titleLinks };
    }
    return entry;
  });
  // The commit to open on, when the address names none.
  const open = annotations?.open ? pages.findIndex((page) => page.sha.startsWith(annotations.open) || annotations.open.startsWith(page.sha)) : -1;
  const count = `${pages.length} commit${pages.length === 1 ? '' : 's'}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${annotations?.title ? escapeHtml(annotations.title) : `${escapeHtml(title)} — ${escapeHtml(path.basename(where))}`}</title>
${await style('style.css')}
${await style('stack.css')}
</head>
<body class="sv-body">
<div id="sv-root" class="sv-root" data-title="${escapeHtml(annotations?.title || title)}"${open > 0 ? ` data-open="${open}"` : ''}>
<header class="sv-header">
<button type="button" class="sv-list-toggle" id="sv-list-toggle" title="Show or hide the list (Alt+L)" aria-label="Show or hide the list">☰</button>
${
  // A program's name for the stack, in place of the range and where it was read, which stay in its tooltip.
  annotations?.title
    ? `<div class="sv-title sv-title-named" title="${escapeHtml(`${title} ${where}`)}">${escapeHtml(annotations.title)}</div>`
    : `<div class="sv-title"><span class="sv-title-revset">${escapeHtml(title)}</span> <span class="sv-title-where">${escapeHtml(where)}</span></div>`
}
<span class="sv-count">${count}</span>
<div class="sv-review" id="sv-review" hidden>
<span class="sv-review-count"></span>
<button type="button" class="sv-review-copy" id="sv-review-copy">Copy all reviews</button>
</div>
<label class="sv-layout"><input type="checkbox" id="sv-layout"> Side by side</label>
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
${carried}${await script('stack.js')}
</body>
</html>
`;
}
