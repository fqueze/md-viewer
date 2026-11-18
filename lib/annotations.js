/**
 * Annotations: what a tool that drives the viewer knows about each commit and
 * wants shown on it — a review status, links in the title, controls that act
 * on the commit.
 *
 * The viewer only shows them. It does not know what "approved" means or what
 * an action does: it draws them, and tells the page that embeds it when one
 * is used, by an `mdv-action` event in the top window. That page acts, and
 * can hand the viewer a new annotation for the commit to redraw it in place.
 *
 * The file is JSON, keyed by full commit sha:
 *
 *   { "title"?: "…", "commits": { "<sha>": { status, titleLinks, actions } } }
 *
 * Every field is optional. README.md describes each.
 */

import fsp from 'node:fs/promises';

/**
 * Read an annotations file, refusing one that is not shaped like one: a typo
 * in a file another program wrote is worth an error now rather than a page
 * that quietly shows nothing.
 * @returns {Promise<{commits: Record<string, object>}>}
 */
export async function readAnnotations(file) {
  let text;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not JSON: ${error.message}`);
  }
  return checkAnnotations(data, file);
}

/** The same checks, for annotations already parsed. */
export function checkAnnotations(data, name = 'the annotations') {
  if (!data || typeof data !== 'object' || !data.commits || typeof data.commits !== 'object') {
    throw new Error(`${name} has no "commits" object`);
  }
  if (data.title != null && typeof data.title !== 'string') throw new Error(`${name} has a "title" that is not a string`);
  for (const [sha, annotation] of Object.entries(data.commits)) {
    if (!annotation || typeof annotation !== 'object') {
      throw new Error(`${name}: commit ${sha} is not an object`);
    }
    for (const list of ['titleLinks', 'actions']) {
      if (annotation[list] != null && !Array.isArray(annotation[list])) {
        throw new Error(`${name}: commit ${sha} has a "${list}" that is not a list`);
      }
    }
  }
  return data;
}

/**
 * The annotation for one commit, or null. Looked up by full sha, and failing
 * that by prefix either way, since a diff piped into diff-viewer may name its
 * commit by an abbreviation.
 */
export function annotationFor(annotations, sha) {
  if (!annotations || !sha) return null;
  const commits = annotations.commits;
  if (commits[sha]) return commits[sha];
  for (const [key, annotation] of Object.entries(commits)) {
    if (key.startsWith(sha) || sha.startsWith(key)) return annotation;
  }
  return null;
}
