/**
 * stack-viewer for a program that serves the review itself, as a web server
 * does, rather than running stack-viewer for a page holding every commit:
 *
 *   const stack = await openStack(findStackRepository(dir));
 *   const commits = await stack.list('main..topic');
 *   const patches = await readStack(stack, commits);          // their sources
 *   buildStackShell(patches.map(commitSummary), { title, where, annotations, pageUrl, assetUrl });
 *   // then, as each commit's page is asked for:
 *   const [versions] = await readFileVersions(stack, [patch]);
 *   buildCommitPage({ ...patch, versions }, { annotation, annotated, assetUrl });
 *   // and the assets, by name:
 *   assetText(name);
 *
 * The list is all the stack page has to build first, from the commits'
 * sources; each commit's page, the costly part, is built when the page asks
 * for it, which is first for the commit it opens on. Nothing here caches: a
 * commit's source and page are the same for the same sha, sections and
 * annotation, which the program knows better how to keep.
 *
 * `pageUrl(i)` is where the stack page fetches the `i`th commit's page from,
 * and `assetUrl(name)` where a page links the asset `name`: what assetText
 * gives for that name, the same for the same version of md-viewer.
 */

import { buildDiffDocument } from './diff-page.js';
import { diffSummary, splitCommitMessage } from './diff.js';
import { annotationFor } from './annotations.js';
import { summaryOf } from './stack-page.js';

export { findStackRepository, openStack, readFileVersions, readStack } from './stack.js';
export { buildStackShell } from './stack-page.js';
export { assetText } from './diff-page.js';
export { annotationFor };

/** What the stack page's list shows of a patch (`{sha, label, source}`), without rendering it. */
export function commitSummary(patch) {
  return summaryOf(patch, diffSummary(patch.source));
}

/**
 * One commit's page, for the stack page's frame: `patch` is `{sha, label,
 * source, versions}`, and `annotation` this commit's, with `annotated` saying
 * a program drives the page (see annotations.js).
 */
export async function buildCommitPage(patch, { annotation = null, annotated = false, assetUrl }) {
  const subject = splitCommitMessage(patch.source).message?.body.split('\n')[0] || null;
  const { html } = await buildDiffDocument(patch.source, {
    title: patch.label,
    subtitle: subject,
    commit: patch.sha,
    embedded: true,
    annotated,
    annotation,
    versions: patch.versions ?? null,
    assetUrl,
  });
  return html;
}
