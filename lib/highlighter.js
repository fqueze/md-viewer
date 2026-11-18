/**
 * highlight.js for the page: the diff is coloured in the browser, a commit at
 * a time as it is shown, rather than here for every commit of a stack before
 * the page can be sent.
 *
 * highlight.js ships each language as a module of its own, so a page carries
 * the core and the languages of its files only. They are CommonJS modules
 * with nothing to import, wrapped here into plain scripts: the core defines
 * `window.hljs`, and each language registers itself with it.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import hljs from 'highlight.js';

const LIB = path.dirname(createRequire(import.meta.url).resolve('highlight.js/lib/core'));

const scripts = new Map();

function read(file) {
  if (!scripts.has(file)) scripts.set(file, fs.readFileSync(path.join(LIB, file), 'utf8'));
  return scripts.get(file);
}

/** The core, defining `window.hljs`. */
export function coreScript() {
  return (
    '(function () {\nvar module = { exports: {} }, exports = module.exports;\n' +
    read('core.js') +
    '\nwindow.hljs = module.exports;\n})();\n'
  );
}

/** One language, registered with the `window.hljs` the core defined. */
export function languageScript(id) {
  if (!hljs.listLanguages().includes(id)) throw new Error(`no highlight.js language ${id}`);
  return (
    '(function () {\nvar module = { exports: {} }, exports = module.exports;\n' +
    read(path.join('languages', `${id}.js`)) +
    `\nwindow.hljs.registerLanguage(${JSON.stringify(id)}, module.exports);\n})();\n`
  );
}

/** The languages a language hands parts of its text to, such as HTML's scripts and styles. */
function embedded(id) {
  const found = new Set();
  const seen = new Set();
  const walk = (mode) => {
    if (!mode || typeof mode !== 'object' || seen.has(mode)) return;
    seen.add(mode);
    const sub = mode.subLanguage;
    for (const name of Array.isArray(sub) ? sub : sub ? [sub] : []) {
      const language = hljs.getLanguage(name);
      const other = language && hljs.listLanguages().find((x) => hljs.getLanguage(x) === language);
      if (other && other !== id) found.add(other);
    }
    for (const value of Object.values(mode)) {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === 'object') walk(value);
    }
  };
  walk(hljs.getLanguage(id));
  return found;
}

/** The languages to load for these, with those they embed, each once. */
export function languagesFor(ids) {
  const out = new Set();
  const add = (id) => {
    if (!id || out.has(id)) return;
    out.add(id);
    embedded(id).forEach(add);
  };
  [...ids].forEach(add);
  return [...out];
}

/** The languages of a rendered page's files. */
export function languagesOf(html) {
  return languagesFor([...html.matchAll(/ data-lang-(?:old|new)="([^"]+)"/g)].map((m) => m[1]));
}
