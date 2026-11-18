/**
 * The diff review page, as one self-contained HTML document.
 *
 * Shared by diff-viewer, which is all page and no server, and by md-viewer,
 * which serves one of these when a commit id in a document is clicked. Both
 * want the same page for the same reason: a diff cannot change under the
 * reader, so inlining the stylesheet and the scripts means the tab needs
 * nothing further from whichever process built it — and can outlive it.
 */

import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDiff, summaryHtml } from './diff.js';
import { coreScript, languageScript, languagesOf } from './highlighter.js';

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

/** One of the assets, by its name: a file of assets/, or a script of highlight.js. */
export async function assetText(name) {
  if (name === 'hljs/core.js') return coreScript();
  const language = /^hljs\/([\w-]+)\.js$/.exec(name);
  if (language) return languageScript(language[1]);
  if (!/^[\w-]+\.(css|js)$/.test(name)) throw new Error(`no asset ${name}`);
  return fsp.readFile(path.join(ASSETS, name), 'utf8');
}

async function styleTag(name) {
  return `<style>\n${await assetText(name)}</style>\n`;
}

async function scriptTag(name) {
  return `<script>\n${await assetText(name)}</script>\n`;
}

const REVIEW_BAR =
  '<div id="mdv-review" class="mdv-review-bar" hidden>' +
  '<span class="mdv-review-count"></span>' +
  '<button type="button" class="mdv-review-copy">Copy review</button>' +
  '</div>';

/**
 * Build the page.
 *
 * `title` names the diff in the tab and the header. `subtitle`, when given, is
 * shown next to it — md-viewer puts the commit's own subject there, since a
 * reader working through a list of shas is looking for the change, not the id.
 *
 * `commit` is the full sha when this page is one commit rather than a loose
 * diff. It goes into the document, not just the heading: the page's review
 * comments are copied out as text, and that text has to say which commit it is
 * about once it is pasted somewhere that has no idea which tab it came from.
 *
 * `embedded` is for a page shown inside stack-viewer, whose own bar has the
 * layout switch: the page's toolbar is left out of sight, though its switch
 * stays in the document for stack-viewer to drive.
 *
 * `annotated` says the page is driven by another program, which annotates
 * its commits (see annotations.js): the page then carries the script that
 * draws an annotation, and `annotation` is this commit's, or null for one the
 * program has said nothing about yet — it may still, in place.
 *
 * An embedded page is coloured with the stack page's highlight.js.
 */
export async function buildDiffPage(source, options) {
  return (await buildDiffDocument(source, options)).html;
}

/**
 * The page, along with what the renderer counted while building it: the
 * files, additions and deletions, and the commit message if the source had
 * one. A page that shows several of these — stack-viewer lists one per commit
 * — wants those figures for its list, and rendering a diff is the expensive
 * step, so it is done once.
 * @returns {Promise<{html: string, rendered: ReturnType<typeof renderDiff>}>}
 */
export async function buildDiffDocument(
  source,
  {
    title,
    subtitle = null,
    commit = null,
    embedded = false,
    annotated = false,
    annotation = null,
  } = {},
) {
  // An annotation's sections are drawn with the diff, as part of the
  // document a comment can be written on, and so once: a later annotation
  // changes the rest of the commit's annotation in place, not these.
  const rendered = renderDiff(source, { sections: annotation?.sections ?? [] });

  // highlight.js, unless the stack page around this one has it.
  const hljs =
    embedded ? [] : languagesOf(rendered.html).length ? ['hljs/core.js', ...languagesOf(rendered.html).map((id) => `hljs/${id}.js`)] : [];
  const styles = (await Promise.all(['style.css', 'diff.css'].map(styleTag))).join('');
  const scripts = async (names) => (await Promise.all(names.map(scriptTag))).join('');

  // The annotation is data for the page's script, which draws it, rather
  // than markup: the program driving the page can replace it later, and the
  // one drawing is then the same code as the first.
  const annotationScript = annotated
    ? `<script type="application/json" id="mdv-annotation">${jsonForScript(annotation)}</script>\n` +
      (await scripts(['annotate.js']))
    : '';

  const identity =
    (commit ? ` data-commit="${escapeHtml(commit)}"` : '') +
    (subtitle ? ` data-subject="${escapeHtml(subtitle)}"` : '');

  // A commit's message is shown with its own bar naming it and saying how
  // large it is, so the toolbar would only repeat it. A loose diff has no
  // such bar, and the toolbar says what it is.
  const heading = subtitle
    ? `<div class="mdv-path"><span class="mdv-path-dir">${escapeHtml(title)} </span>` +
      `${escapeHtml(subtitle)}</div>`
    : `<div class="mdv-path">${escapeHtml(title)}</div>`;
  const toolbarText = rendered.commit
    ? ''
    : `${heading}\n<div class="dv-summary">${summaryHtml(rendered)}</div>`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subtitle ? `${subtitle} — ${title}` : title)}</title>
${styles}
</head>
<body>
<div id="mdv-root" class="dv-root" data-file="${escapeHtml(title)}"${identity}>
<div class="dv-toolbar"${embedded ? ' hidden' : ''}>
${toolbarText}
<label class="dv-layout-toggle"><input type="checkbox" id="dv-layout"> Side by side</label>
</div>
<article id="mdv-content">
${rendered.html}
</article>
</div>
${REVIEW_BAR}
${await scripts(['review.js', 'diff.js'])}
${annotationScript}${await scripts([...hljs, 'colour.js'])}</body>
</html>
`;
  return { html, rendered };
}
