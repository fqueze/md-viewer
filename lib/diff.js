/**
 * Render a unified diff to HTML, Phabricator-style: a line changed only by
 * whitespace says so, and a line where one word moved shows that word rather
 * than lighting up whole.
 *
 * The markup is layout-agnostic: a changed line and the line it replaced sit
 * together in one row, and the stylesheet decides whether to stack them
 * (unified) or set them side by side. So the toggle in the page is a class
 * flip, never a re-render — which is what keeps review comments attached to
 * the passage they were written against.
 *
 * Side by side repeats each unchanged line in both columns. The second copy is
 * marked `mdv-aside`, which review.js leaves out of the text it searches and
 * quotes, so a line drawn twice is still anchored and quoted once.
 */

import path from 'node:path';
import parseDiff from 'parse-diff';
import { diffWordsWithSpace } from 'diff';
import hljs from 'highlight.js';
import { renderMarkdown } from './render.js';

/**
 * Below this much shared text, a pair of lines is treated as a rewrite and
 * shown whole. Word highlighting on two unrelated lines is confetti: it marks
 * every word, which reads as noisier than no marking at all.
 */
const SIMILARITY_FLOOR = 0.35;
/**
 * How far ahead of the runner-up a match has to be to be believed. Two lines
 * that score within this of each other are not one line and its edit; they are
 * a paragraph reflowed, where the old line's text ended up spread across both.
 */
const DECISIVE_MARGIN = 0.08;
/**
 * How much of a deleted line its candidate insertions have to account for
 * between them before they count as the line split in two rather than rivals
 * for the same text.
 */
const SPLIT_COVERAGE = 0.8;
/** Matching a run is quadratic, so give up on the pathological ones. */
const MAX_PAIRED_CELLS = 40000;
/** Files whose name says what they are where their extension does not. */
const LANGUAGE_BY_NAME = {
  makefile: 'makefile',
  'moz.build': 'python',
  'moz.configure': 'python',
};

/** Extensions highlight.js reads as another language than the one they hold. */
const LANGUAGE_BY_EXTENSION = {
  h: 'cpp',
};

/**
 * Languages left plain. A patch in a patch would paint its own +/- backgrounds
 * inside rows that already carry them.
 */
const PLAIN_LANGUAGES = new Set(['plaintext', 'diff'].map((name) => hljs.getLanguage(name)));

const escape = (text) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ---------------------------------------------------------------------------
// Syntax highlighting
// ---------------------------------------------------------------------------

/**
 * The highlight.js language for a path, by the name highlight.js files it
 * under (javascript for an .mjs), or null to leave the file plain. The page
 * loads that language's module to colour it.
 */
export function languageId(file) {
  if (!file || file === '/dev/null') {
    return null;
  }
  const base = path.basename(file).toLowerCase();
  const ext = path.extname(base).slice(1);
  const name = LANGUAGE_BY_NAME[base] ?? LANGUAGE_BY_EXTENSION[ext] ?? ext;
  const language = name && hljs.getLanguage(name);
  if (!language || PLAIN_LANGUAGES.has(language)) {
    return null;
  }
  return idOf(language);
}

let ids = null;

/** The name highlight.js registered a language under. */
function idOf(language) {
  if (!ids) ids = new Map(hljs.listLanguages().map((id) => [hljs.getLanguage(id), id]));
  return ids.get(language);
}

const attribute = (name, value) => (value ? ` ${name}="${escape(value)}"` : '');

/**
 * Draw a line, with the stretches in `marks` wrapped as changed words. Its
 * syntax colours are the page's to add (highlight.js in assets/), inside
 * those: a changed phrase stays one mark however many tokens it crosses.
 */
function paint(text, marks, showSpace) {
  const show = showSpace ? visibleSpace : escape;
  let html = '';
  let at = 0;
  for (const [from, to] of marks) {
    html += show(text.slice(at, from)) + `<span class="dv-word">${show(text.slice(from, to))}</span>`;
    at = to;
  }
  return html + show(text.slice(at));
}

// ---------------------------------------------------------------------------
// Intra-line comparison
// ---------------------------------------------------------------------------

/** True once two lines differ in nothing but their spaces and tabs. */
function whitespaceOnly(before, after) {
  return before !== after && before.replace(/\s+/g, '') === after.replace(/\s+/g, '');
}

/** How wide a line's indent is drawn, with a tab reaching the next stop of 8. */
function indentWidth(text) {
  let width = 0;
  for (const c of text.match(/^\s*/)[0]) {
    width = c === '\t' ? width - (width % 8) + 8 : width + 1;
  }
  return width;
}

/**
 * Which way a whitespace-only change moved the line's indent: '»' for in, '«'
 * for out, or null when the change is elsewhere in the line or leaves the
 * indent as wide as it was. A reindent is shown as that one mark in the
 * gutter, as Phabricator does, rather than as the spaces spelled out: the
 * direction is all there is to say about it.
 */
function indentChange(before, after) {
  if (before.trimStart() !== after.trimStart() || !before.trim()) {
    return null;
  }
  const delta = indentWidth(after) - indentWidth(before);
  if (!delta) return null;
  return delta > 0 ? '»' : '«';
}

/**
 * Make whitespace visible, for the runs a whitespace-only change touches. The
 * point of such a line is the part you cannot see, so the changed spans show
 * their spaces and tabs; everywhere else keeps real characters, since a page
 * full of dots is harder to read than the code it stands for.
 */
function visibleSpace(text) {
  return escape(text).replace(/ /g, '·').replace(/\t/g, '→ ');
}

/**
 * What two lines have in common: the length of the shared text, that length as
 * a fraction of the two, and the stretches of the *first* line that the second
 * accounts for. The ranges are what tells a line split in two from two rivals
 * for the same text — pieces of a split cover different parts of the original,
 * rivals cover the same part twice.
 */
function overlap(parts) {
  let common = 0;
  let total = 0;
  let at = 0;
  const ranges = [];
  for (const part of parts) {
    const length = part.value.length;
    total += length;
    if (part.added) {
      // Present only in the second line, so it advances nothing in the first.
      continue;
    }
    if (!part.removed) {
      common += length;
      ranges.push([at, at + length]);
    }
    at += length;
  }
  // Shared text is counted once but spans both lines, hence the doubling.
  return { common, ranges, ratio: total ? (2 * common) / (total + common) : 1 };
}

/** How alike two lines are, from 0 to 1. */
function similarity(parts) {
  return overlap(parts).ratio;
}

/**
 * The stretches of one side of a changed pair to mark as the words that moved,
 * as [start, end) offsets into that side's text. `side` picks which of the two
 * the parts belong to: a deletion takes the removed runs and skips the added
 * ones, an insertion the reverse.
 */
function marksOf(parts, side) {
  const mine = side === 'del' ? 'removed' : 'added';
  const theirs = side === 'del' ? 'added' : 'removed';

  // The word diff hands back one part per word, so a changed phrase arrives as
  // several parts with the spaces between them unchanged. Marking each on its
  // own would draw a run of blocks with gaps at every space; the phrase is one
  // change, so it is gathered into one mark. Only whitespace is absorbed that
  // way — a space between two changed words is inside the phrase, while any
  // real text between them means they are two separate changes.
  const marks = [];
  let run = null;
  let at = 0;
  for (const part of parts) {
    if (part[theirs]) {
      continue;
    }
    const end = at + part.value.length;
    if (part[mine]) {
      // Extending the run to here takes in the gap before this word too.
      if (run) {
        run[1] = end;
      } else {
        run = [at, end];
      }
    } else if (run && part.value.trim()) {
      marks.push(run);
      run = null;
    }
    at = end;
  }
  if (run) marks.push(run);
  return marks;
}

/** One side of a changed pair as markup, with the words that moved marked. */
function markUp(line, parts, side, showSpace) {
  return paint(line.text, marksOf(parts, side), showSpace);
}

/** A line with nothing in it marked. */
const plain = (line) => paint(line.text, [], false);

/** Total length covered by a set of [start, end) ranges, counting overlaps once. */
function union(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -1;
  for (const [from, to] of sorted) {
    if (to <= end) continue;
    total += to - Math.max(from, end);
    end = to;
  }
  return total;
}

/**
 * Which insertion, if any, each deletion is a version of.
 *
 * Position is not enough. A run that rewrites one line and inserts ten above it
 * would pair the rewritten line with the first insertion and highlight the
 * words two unrelated lines happen to share, when the line it is really a
 * version of is further down. So every candidate is scored against every other
 * and the best matches win.
 *
 * A match also has to be *clearly* the best. Reflowing a paragraph moves text
 * across line breaks until two different new lines each hold part of an old
 * one, and neither is the line it became; the scores come out close, and
 * picking the higher one is a coin toss that lights up an arbitrary half of the
 * paragraph. Those are left unpaired, and shown as a line gone and lines
 * arrived. A real edit does not look like that: appending a sentence to a line
 * scores far above every other candidate, however lopsided the run is.
 *
 * @returns {Map<number, number[]>} index in `dels` to the indexes in `adds` it
 *   became — more than one only when the line was split in two.
 */
function matchLines(dels, adds) {
  const scores = [];
  /** The best and second-best score each line takes part in. */
  const bestDel = dels.map(() => [0, 0]);
  const bestAdd = adds.map(() => [0, 0]);
  /** Per deletion, the stretches of it each candidate insertion accounts for. */
  const covered = dels.map(() => []);

  const note = (best, score) => {
    if (score > best[0]) {
      best[1] = best[0];
      best[0] = score;
    } else if (score > best[1]) {
      best[1] = score;
    }
  };

  for (let d = 0; d < dels.length; d++) {
    for (let a = 0; a < adds.length; a++) {
      const before = dels[d].text;
      const after = adds[a].text;
      const { ranges, ratio } = overlap(diffWordsWithSpace(before, after));
      // Two lines that hold nothing but whitespace share no words to score, so
      // similarity puts them at zero however alike they are — and a line whose
      // indentation was changed or dropped is the clearest case there is of one
      // line becoming another. Pair them on being blank alone.
      const blank = !before.trim() && !after.trim();
      if (!blank && ratio < SIMILARITY_FLOOR) {
        continue;
      }
      // A blank pair scores above the floor so it can win its line, but below
      // any real match, which should always be preferred to it.
      const score = blank ? SIMILARITY_FLOOR : ratio;
      scores.push({ d, a, score });
      note(bestDel[d], score);
      note(bestAdd[a], score);
      covered[d].push(ranges);
    }
  }

  // A deletion was split rather than rewritten when its candidates account
  // between them for nearly all of it *and* each holds a part the others do
  // not. Both halves matter: coverage alone is met by a single near-identical
  // candidate, and distinctness alone by two lines sharing one word. Rivals for
  // the same line fail the second test — they cover the same stretch twice —
  // which is what leaves them to the tie rejection below. An empty line covers
  // nothing and is nobody's half.
  const split = dels.map((del, d) => {
    const pieces = covered[d];
    if (!del.text.length || pieces.length < 2) {
      return false;
    }
    if (union(pieces.flat()) < del.text.length * SPLIT_COVERAGE) {
      return false;
    }
    // Every piece has to earn its place: take it away and the coverage drops,
    // because it was holding text none of the others hold.
    const whole = union(pieces.flat());
    return pieces.every((_, i) => union(pieces.filter((__, j) => j !== i).flat()) < whole);
  });

  // Best match first, so a strong pair claims its lines before a weaker one
  // that wanted the same line can. Ties keep the earlier line, which preserves
  // the order of a run whose lines are equally alike.
  scores.sort((x, y) => y.score - x.score || x.d - y.d || x.a - y.a);

  const byDel = new Map();
  const takenAdds = new Set();
  for (const { d, a, score } of scores) {
    // A split line claims every piece of itself; any other takes one match.
    if (takenAdds.has(a) || (byDel.has(d) && !split[d])) {
      continue;
    }
    // A near-tie means two insertions are equally good answers for one deleted
    // line, which is not an edit anyone made — unless they are the two halves
    // of it, which `split` has already established.
    const rival = Math.max(bestDel[d][1], bestAdd[a][1]);
    if (!split[d] && rival && score - rival < DECISIVE_MARGIN) {
      continue;
    }
    if (byDel.has(d)) {
      byDel.get(d).push(a);
    } else {
      byDel.set(d, [a]);
    }
    takenAdds.add(a);
  }
  // Kept in the order they appear, so the pieces of a split line read top down.
  for (const list of byDel.values()) {
    list.sort((x, y) => x - y);
  }
  return byDel;
}

/**
 * Pair the deletions and insertions of one changed run, so each line can be
 * compared against the line it replaced. A line with no counterpart is emitted
 * on its own: it was added or removed outright, and has nothing to be compared
 * against.
 */
function pairRun(dels, adds) {
  // Matching is quadratic in the size of the run, so a pathological one is
  // shown plain rather than allowed to hang the render.
  const matched =
    dels.length * adds.length > MAX_PAIRED_CELLS ? new Map() : matchLines(dels, adds);

  /** For each insertion, the deletion it is a piece of. */
  const pieceOf = new Map();
  for (const [d, list] of matched) {
    for (const at of list) pieceOf.set(at, d);
  }

  // Both sides are emitted in their own order — that order is the file, and no
  // amount of matching may disturb it. Deletions are laid against insertions
  // from the top down, so the nth old line of a run meets the nth new one.
  //
  // Position, not score, is what decides which row a deletion is drawn on. A
  // sentence rewritten over three lines often resembles one of the middle ones
  // most, because that is where its surviving words landed; drawing the old
  // line against that one would leave the insertions above it stranded and the
  // diff reading out of order. The matcher still says whether two lines are a
  // pair and how they are marked against each other — this only says where.
  const pairs = [];
  let d = 0;
  let at = 0;

  // Runs until both sides are spent. A row that carries the continuation of a
  // line drawn above takes an insertion without taking a deletion, so the two
  // sides do not advance in step and neither length alone bounds the walk.
  while (at < adds.length || d < dels.length) {
    const add = at < adds.length ? adds[at] : null;
    const del = d < dels.length ? dels[d] : null;

    // An insertion that continues a deletion drawn on an earlier row has no
    // deletion of its own: that line is already accounted for above.
    const owner = add ? pieceOf.get(at) : undefined;
    const continues = owner !== undefined && matched.get(owner)[0] !== at;

    if (add && continues) {
      at++;
      const before = dels[owner].text;
      const parts = diffWordsWithSpace(before, add.text);
      pairs.push({
        del: null,
        add,
        addHtml: markUp(add, parts, 'add', whitespaceOnly(before, add.text)),
        space: false,
      });
      continue;
    }

    if (!del) {
      at++;
      pairs.push({ del: null, add, addHtml: plain(add), space: false, entire: true });
      continue;
    }
    const mine = d;
    d++;
    if (!add) {
      pairs.push({ del, add: null, delHtml: plain(del), space: false, entire: true });
      continue;
    }
    const row = at;
    at++;

    // Whether these two are a version of each other, in the matcher's opinion.
    // A row can bring together a deletion and an insertion it was not matched
    // to — the two sides are laid out in their own order, and matching does not
    // have to agree with it. Those are shown plain: neither is an edit of the
    // other, and marking the words they happen to share would claim otherwise.
    const list = matched.get(mine);
    const before = del.text;
    if (!list || !list.includes(row)) {
      pairs.push({
        del,
        add,
        delHtml: plain(del),
        addHtml: plain(add),
        space: false,
        entire: true,
      });
      continue;
    }

    // The deletion is marked against every piece at once: text that moved to a
    // later line has not gone anywhere, and marking it as removed on a line
    // whose words are still in the file two lines down is the opposite of what
    // happened.
    const parts = diffWordsWithSpace(before, add.text);
    const space = whitespaceOnly(before, add.text);
    const indent = space ? indentChange(before, add.text) : null;
    if (indent) {
      pairs.push({ del, add, delHtml: plain(del), addHtml: plain(add), space, indent });
      continue;
    }
    const lost = diffWordsWithSpace(before, list.map((i) => adds[i].text).join('\n'));
    pairs.push({
      del,
      add,
      delHtml: markUp(del, lost, 'del', space),
      addHtml: markUp(add, parts, 'add', space),
      space,
    });
  }
  return pairs;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * Turn a hunk's changes into rows: a context line, or a deletion and the
 * insertion that replaced it, either of which may be missing. Consecutive
 * deletions and insertions are gathered into a run first, because a line can
 * only be compared once its counterpart is known.
 */
function rowsOf(chunk) {
  const rows = [];
  let dels = [];
  let adds = [];

  const flush = () => {
    if (!dels.length && !adds.length) return;
    for (const pair of pairRun(dels, adds)) {
      rows.push({ type: 'change', ...pair });
    }
    dels = [];
    adds = [];
  };

  for (const change of chunk.changes) {
    // parse-diff keeps the leading +/-/space of the original line.
    const text = change.content.slice(1);
    if (change.type === 'del') {
      dels.push({ line: change.ln, text });
    } else if (change.type === 'add') {
      adds.push({ line: change.ln, text });
    } else {
      flush();
      rows.push({
        type: 'context',
        oldLine: change.ln1,
        newLine: change.ln2,
        text,
      });
    }
  }
  flush();
  return rows;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/**
 * A line of the diff.
 *
 * The two layouts differ only in where these land: unified puts every line in
 * one column, side by side puts deletions left and insertions right. Both are
 * grid placements of the same elements, so the toggle never re-renders.
 *
 * `data-line` is the number a review comment reports, and `data-side` says
 * which file that number belongs to.
 */
function lineHtml(
  side,
  oldLine,
  newLine,
  html,
  { space = false, indent = null, entire = false, row = null, text = null } = {},
) {
  // The colours already say which lines are gone and which are new, so the
  // marker column holds no +/-, as on Phabricator. What it holds is the
  // direction of a reindent, on the old line, which is where Phabricator puts
  // it too.
  const reindent = side === 'del' && indent;
  const line = side === 'del' ? oldLine : newLine;
  return (
    `<div class="dv-line dv-line-${side}` +
    (space ? ' dv-line-space' : '') +
    // A line that is new or gone outright colours its whole row, rather than
    // pointing at any part of it.
    (entire ? ' dv-line-entire' : '') +
    `" data-side="${side}"` +
    (line == null ? '' : ` data-line="${line}"`) +
    (space ? ` title="${indent ? 'indentation' : 'whitespace-only'} change"` : '') +
    // Its spaces are spelled out, so the page colouring the line's code reads
    // the code itself from here.
    (space && text != null ? ` data-src="${escape(text)}"` : '') +
    // The row this line was paired into, which side by side places it on.
    (row == null ? '' : ` style="--dv-row: ${row}"`) +
    '>' +
    `<span class="dv-num dv-num-old mdv-aside">${oldLine ?? ''}</span>` +
    `<span class="dv-num dv-num-new mdv-aside">${newLine ?? ''}</span>` +
    `<span class="dv-marker${reindent ? ' dv-marker-indent' : ''} mdv-aside" aria-hidden="true">` +
    `${reindent || ''}</span>` +
    `<span class="dv-text">${html}</span>` +
    '</div>'
  );
}

/**
 * An unchanged line, drawn twice: side by side shows it in both columns. The
 * second copy is marked as an aside: review.js leaves that text out of the
 * document it searches and quotes, so the line still counts once when a
 * comment is anchored, however many times it is drawn.
 *
 * Each copy is coloured as the file it stands in: a change above can open or
 * close a comment, after which the same text is code in one file and prose in
 * the other.
 */
function contextHtml(row) {
  return (
    '<div class="dv-row dv-row-context">' +
    lineHtml('ctx', row.oldLine, row.newLine, escape(row.text)) +
    '<div class="dv-line dv-line-ctx dv-line-mirror mdv-aside" aria-hidden="true">' +
    `<span class="dv-num dv-num-new">${row.newLine ?? ''}</span>` +
    '<span class="dv-marker"></span>' +
    `<span class="dv-text">${escape(row.text)}</span>` +
    '</div>' +
    '</div>'
  );
}

/**
 * A run of changed lines: the deletions, then the insertions that replaced
 * them, in the order the patch has them.
 *
 * That is the order a patch reads in, and the order the markup keeps. It used
 * to hold each deletion next to the insertion it was paired with, so that side
 * by side could draw the two on one row by nesting them — and unified, which
 * shows the markup as it is, then read del, add, del, add: two functions
 * shuffled together line by line. The pairing is still known, and is recorded
 * on each line as the row it belongs to, `--dv-row`; side by side places the
 * lines on their rows by that number, and unified needs nothing.
 *
 * Text selection follows the markup, so this is also what makes a drag down
 * the unified view select what it appears to.
 */
function blockHtml(rows) {
  const dels = [];
  const adds = [];
  rows.forEach((row, i) => {
    const how = { space: row.space, indent: row.indent, entire: row.entire, row: i + 1 };
    if (row.del) {
      dels.push(lineHtml('del', row.del.line, null, row.delHtml, { ...how, text: row.del.text }));
    }
    if (row.add) {
      adds.push(lineHtml('add', null, row.add.line, row.addHtml, { ...how, text: row.add.text }));
    }
  });
  return `<div class="dv-block">${dels.join('')}${adds.join('')}</div>`;
}

/** The rows of a hunk as markup, with each run of changes gathered in a block. */
function hunkRowsHtml(rows) {
  let html = '';
  let run = [];
  const flush = () => {
    if (run.length) html += blockHtml(run);
    run = [];
  };
  for (const row of rows) {
    if (row.type === 'context') {
      flush();
      html += contextHtml(row);
    } else {
      run.push(row);
    }
  }
  flush();
  return html;
}

/**
 * What a hunk header shows: the function or section git named after its
 * `@@ -a,b +c,d @@`, as the file's code (the page colours it), as Phabricator
 * shows it. Where the page can show the lines between hunks, the ranges only
 * say what the line numbers already do, so they are left to the tooltip;
 * elsewhere they say how much is not shown.
 */
function hunkText(content, expandable) {
  const [, ranges = '', name = ''] = content.match(/^(@@[^@]*@@)\s?(.*)$/) || [null, '', content];
  const code = name ? `<span class="dv-hunk-code">${escape(name)}</span>` : '';
  if (!expandable) {
    const shown = ranges ? `<span class="dv-hunk-ranges">${escape(ranges)}</span>${name ? ' ' : ''}` : '';
    return `<span class="dv-hunk-text">${shown}${code}</span>`;
  }
  const title = ranges ? ` title="${escape(ranges)}"` : '';
  return `<span class="dv-hunk-text"${title}>${code}</span>`;
}

/** The `@@ -a,b +c,d @@` line, with whatever section name git put after it. */
function hunkHeader(chunk) {
  return `<div class="dv-row dv-row-hunk">${hunkText(chunk.content, false)}</div>`;
}

/**
 * The lines of the new file a hunk covers, first and last, and the old
 * file's first. A hunk that only deletes covers no new line: git numbers it
 * by the line before the gap, so it starts after that line and ends on it.
 */
function spanOf(chunk) {
  const newFirst = chunk.newLines ? chunk.newStart : chunk.newStart + 1;
  const oldFirst = chunk.oldLines ? chunk.oldStart : chunk.oldStart + 1;
  return { newFirst, newLast: newFirst + chunk.newLines - 1, oldFirst };
}

/**
 * The unchanged lines between two hunks, or before the first or after the
 * last, which the page can show from the file's new version: the hunk header
 * that stands for them, made into a row the page draws its buttons on.
 *
 * `from` and `to` are lines of the new file. An unchanged line has the same
 * text in both files, at a number that is off by however many lines the
 * changes above it added or took away — `delta`, the same for the whole gap —
 * so the old file is not needed to number it.
 */
function expandRow(content, from, to, delta) {
  return (
    `<div class="dv-row dv-row-hunk dv-row-expand mdv-aside" data-from="${from}" data-to="${to}" ` +
    `data-delta="${delta}">${hunkText(content, true)}</div>`
  );
}

/** A file's lines, without the empty one after its last newline. */
export function fileLines(text) {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** A file's lines, once per blob however many commits show it. */
function wholeFile(oid, text, cache) {
  if (cache?.has(oid)) return cache.get(oid);
  const file = { lines: fileLines(text) };
  cache?.set(oid, file);
  return file;
}

/** What to call a file, preferring the new path and noting a rename. */
function fileName(file) {
  const from = file.from && file.from !== '/dev/null' ? file.from : null;
  const to = file.to && file.to !== '/dev/null' ? file.to : null;
  if (from && to && from !== to) return `${from} → ${to}`;
  return to || from || 'unknown file';
}

/** The path a review comment should quote: the new side, since that is what an agent edits. */
function commentPath(file) {
  const to = file.to && file.to !== '/dev/null' ? file.to : null;
  return to || file.from || 'unknown file';
}

function statusOf(file) {
  if (file.new) return 'added';
  if (file.deleted) return 'deleted';
  if (file.from && file.to && file.from !== file.to) return 'renamed';
  return 'changed';
}

/**
 * How many digits the widest line number in this file's hunks has. The
 * gutter is sized from it: a fixed width that fits four digits folds the
 * fifth onto a second row, and a file of ten thousand lines is not rare.
 * Three at least, so a short file's gutter is still a gutter.
 */
function gutterDigits(file) {
  let widest = 0;
  for (const chunk of file.chunks) {
    // `start + lines` is the line after the hunk's last, so a hunk ending at
    // 999 would otherwise ask for a fourth digit it has no number for.
    widest = Math.max(
      widest,
      chunk.oldStart + chunk.oldLines - 1,
      chunk.newStart + chunk.newLines - 1,
    );
  }
  return Math.max(3, String(widest).length);
}

/**
 * A file's section. `version`, when the caller could read them, holds the
 * file's new text and blob id and its old text: the new one is what the
 * page shows more context from, and both are highlighted whole.
 */
function fileHtml(file, index, version, cache, blobs) {
  const whole = version?.newText != null ? wholeFile(version.newOid, version.newText, cache) : null;

  let rows;
  const expandable = whole && file.chunks.length && !file.deleted;
  if (expandable) {
    // Each hunk header becomes the row for the gap above it, and one more
    // row stands for whatever follows the last hunk.
    let last = 0;
    let delta = 0;
    rows = file.chunks
      .map((chunk) => {
        const span = spanOf(chunk);
        const head = expandRow(chunk.content, last + 1, span.newFirst - 1, span.oldFirst - span.newFirst);
        last = span.newLast;
        delta = span.oldFirst + chunk.oldLines - (span.newLast + 1);
        return head + hunkRowsHtml(rowsOf(chunk));
      })
      .join('');
    if (last < whole.lines.length) rows += expandRow('', last + 1, whole.lines.length, delta);
    // What the page draws those lines from.
    if (!blobs.has(version.newOid)) blobs.set(version.newOid, { text: whole.lines });
  } else {
    rows = file.chunks.map((chunk) => hunkHeader(chunk) + hunkRowsHtml(rowsOf(chunk))).join('');
  }

  const stats =
    `<span class="dv-stat dv-stat-add">+${file.additions}</span>` +
    `<span class="dv-stat dv-stat-del">−${file.deletions}</span>`;

  const blob = expandable ? ` data-blob="${escape(version.newOid)}"` : '';
  // Shown in full, the file reaches its last line, whose number the gutter
  // then has to hold.
  const digits = Math.max(gutterDigits(file), expandable ? String(whole.lines.length).length : 0);
  // The languages the page colours each version in, by highlight.js's names.
  const languages =
    attribute('data-lang-old', languageId(file.from)) + attribute('data-lang-new', languageId(file.to));
  return (
    `<section class="dv-file" id="dv-file-${index}" data-path="${escape(commentPath(file))}"${blob}${languages}>` +
    '<header class="dv-file-header">' +
    `<button type="button" class="dv-copy-path mdv-aside" data-copy="${escape(commentPath(file))}" ` +
    'title="Copy the path" aria-label="Copy the path"></button>' +
    `<span class="dv-file-name">${escape(fileName(file))}</span>` +
    // A file is changed unless it says otherwise, so only otherwise is worth a badge.
    (statusOf(file) === 'changed' ? '' : `<span class="dv-file-status dv-status-${statusOf(file)}">${statusOf(file)}</span>`) +
    stats +
    '</header>' +
    (file.chunks.length
      ? `<div class="dv-table" style="--dv-digits: ${digits}">${rows}</div>`
      : '<div class="dv-file-empty">No textual changes.</div>') +
    '</section>'
  );
}

// ---------------------------------------------------------------------------
// The commit message above a patch
// ---------------------------------------------------------------------------

/**
 * Split the preamble `git show` puts above the first file off the patch.
 *
 * A patch of a commit carries the message that explains it, and the message is
 * the part that says *why* — which is most of what a reviewer needs and all of
 * what the subject line alone leaves out. parse-diff only looks at the file
 * sections, so left in the source it is silently dropped.
 *
 * Recognised by the header `git show` always writes first: a `commit <sha>`
 * line. A patch from `git diff`, or one piped in from anywhere else, has no
 * such header and is returned unchanged — there is no message to find, and
 * guessing from arbitrary leading text would eat a real diff's context.
 *
 * @returns {{message: {headers: Array<[string, string]>, body: string}|null,
 *            patch: string}}
 */
export function splitCommitMessage(source) {
  if (!/^commit [0-9a-f]{7,40}/.test(source)) {
    return { message: null, patch: source };
  }
  const lines = source.replace(/\r\n/g, '\n').split('\n');

  // The headers run to the first blank line: `commit`, then the trailer lines
  // git chooses — Author, Date, and on a merge a Merge line as well.
  const headers = [];
  let i = 0;
  for (; i < lines.length && lines[i].trim(); i++) {
    const match = /^(\w+):?\s+(.*)$/.exec(lines[i]);
    if (match) {
      headers.push([match[1], match[2].trim()]);
    }
  }

  // The message body is indented by four spaces; the diff and the --stat block
  // that may precede it are not, so the first line that is neither indented nor
  // blank ends the message.
  const body = [];
  for (i++; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('    ')) {
      body.push(line.slice(4));
    } else if (!line.trim()) {
      body.push('');
    } else {
      break;
    }
  }

  // Everything from here on is the --stat block and the diff itself. The stat
  // is left in the patch text: parse-diff ignores it, and the summary the page
  // draws is counted from the files rather than read out of it.
  return {
    message: { headers, body: body.join('\n').trim() },
    patch: lines.slice(i).join('\n'),
  };
}

/**
 * Where a bug number in a commit message points. Mozilla's Bugzilla unless
 * `MD_VIEWER_BUG_URL` says otherwise, with `{id}` standing for the number.
 */
const BUG_URL = process.env.MD_VIEWER_BUG_URL || 'https://bugzilla.mozilla.org/show_bug.cgi?id={id}';

/**
 * Turn `Bug 1951421` in an escaped line of the message into a link to the bug.
 *
 * The bug is where the message's context lives — the discussion, the earlier
 * attempts, the tests that failed — and a reviewer reading "Bug 1951421 -
 * Hold the gesture decision" wants to read the bug next. The whole reference
 * is the link, so the word is the click target and not only the number.
 *
 * Four digits at least: a message that says "bug 2" is not naming one. The
 * link opens in a new tab, as every outward link in the viewer does, so the
 * review being written in this one is not unloaded.
 *
 * Runs on escaped text, so the number is the only thing rewritten and the
 * text nodes review.js reads are unchanged apart from the boundary the link
 * adds — which a comment across it already survives, as it does a bold run.
 */
export function linkBugs(html) {
  return html.replace(/\b(bug\s+#?)(\d{4,8})\b/gi, (match, word, id) => {
    const href = BUG_URL.replace('{id}', id);
    return `<a class="dv-bug" href="${escape(href)}" target="_blank" rel="noopener">${match}</a>`;
  });
}

/** Link HTTP URLs without changing the text a review quotes from the message. */
function linkMessageLine(line) {
  const urls = /https?:\/\/(?:(?!\]\()[^\s<>"'])+/gi;
  let html = '';
  let end = 0;
  for (const match of line.matchAll(urls)) {
    const start = match.index;
    let url = match[0];
    // Sentence punctuation and Markdown's closing delimiters are not part of
    // the URL. Keep a closing parenthesis or bracket when it is balanced by
    // one inside the URL itself.
    while (/[.,;:!?)]$/.test(url) ||
      (url.endsWith(']') && (url.match(/\]/g) || []).length > (url.match(/\[/g) || []).length)) {
      if (url.endsWith(')') &&
          (url.match(/\)/g) || []).length <= (url.match(/\(/g) || []).length) break;
      url = url.slice(0, -1);
    }
    html += linkBugs(escape(line.slice(end, start)));
    html += `<a class="dv-url" href="${escape(url)}" target="_blank" rel="noopener">${escape(url)}</a>`;
    end = start + url.length;
  }
  return html + linkBugs(escape(line.slice(end)));
}

/** `3 files changed +12 −4`, as the page shows a diff's size. */
export function summaryHtml({ files, additions, deletions }) {
  return (
    `<span>${files} file${files === 1 ? '' : 's'} changed</span>` +
    `<span class="dv-stat dv-stat-add">+${additions}</span>` +
    `<span class="dv-stat dv-stat-del">−${deletions}</span>`
  );
}

/**
 * When a commit was written, as Phabricator says it: `Mon, Nov 2, 9:57 PM`,
 * with the year only when it is not this one. The date git wrote is kept for
 * the tooltip; a date that does not parse is shown as git wrote it.
 */
function dateHtml(date) {
  const when = new Date(date);
  if (Number.isNaN(when.getTime())) {
    return escape(date);
  }
  const format = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  if (when.getFullYear() !== new Date().getFullYear()) {
    format.year = 'numeric';
  }
  const shown = new Intl.DateTimeFormat('en-US', format).format(when);
  return `<span class="dv-msg-value" title="${escape(date)}">${escape(shown)}</span>`;
}

/**
 * The bar over the message: the commit, who wrote it and when, as Phabricator
 * words it — "Authored by florian on Mon, Nov 2, 9:57 PM." — and the size of
 * the diff at its far end. The author goes by their first name, with the name
 * and address git has for them in the tooltip. Any other header git wrote,
 * such as a merge's parents, is shown as it was.
 */
function messageHeaderHtml(headers, stats) {
  const value = (key) => headers.find(([k]) => k === key)?.[1];
  const sha = value('commit');
  const author = value('Author');
  const date = value('Date');

  let html = '';
  if (sha) {
    html += `<span class="dv-msg-sha" title="${escape(sha)}">${escape(sha.slice(0, 12))}</span>`;
  }
  if (author || date) {
    html += '<span class="dv-msg-header">Authored';
    if (author) {
      const name = author.replace(/\s*<[^>]*>$/, '');
      html += ` by <span class="dv-msg-value" title="${escape(author)}">${escape(name.split(/\s+/)[0])}</span>`;
    }
    if (date) {
      html += ` on ${dateHtml(date)}`;
    }
    html += '.</span>';
  }
  for (const [key, text] of headers) {
    if (key === 'commit' || key === 'Author' || key === 'Date') continue;
    html +=
      `<span class="dv-msg-header">${escape(key)}: ` +
      `<span class="dv-msg-value">${escape(text)}</span></span>`;
  }
  return html + `<span class="dv-summary">${summaryHtml(stats)}</span>`;
}

/**
 * The commit message as a block above the files.
 *
 * Inside the article rather than in the toolbar, and built out of the same
 * line rows the diff uses: a reviewer wants to comment on the message at least
 * as often as on the code — a claim in it can be wrong when every line of the
 * patch is right — and only content in the document can be selected, anchored
 * and quoted back. `data-side="msg"` is what tells the page's review hooks that
 * a comment here belongs to the message and not to a file.
 */
function messageHtml(message, stats, sections) {
  const rows = message.body
    .split('\n')
    .map(
      (line, i) =>
        `<div class="dv-line dv-line-msg" data-side="msg" data-msg-line="${i + 1}">` +
        `<span class="dv-num"></span>` +
        // A blank line stays genuinely empty. Padding it with a non-breaking
        // space would give the row its height, but it also becomes the row's
        // text — and a review that quotes the message back would carry a
        // U+00A0 where the writer left an empty line. The height comes from
        // CSS instead, which the copied text cannot see.
        `<span class="dv-text">${linkMessageLine(line)}</span>` +
        '</div>',
    )
    .join('');

  return (
    '<section class="dv-file dv-message" data-path="the commit message">' +
    `<header class="dv-file-header">${messageHeaderHtml(message.headers, stats)}</header>` +
    `<div class="dv-table dv-msg-table">${rows}</div>` +
    sections +
    '</section>'
  );
}

// ---------------------------------------------------------------------------
// Sections between the message and the files
// ---------------------------------------------------------------------------

/**
 * A section a program added to the commit, such as its test plan: under the
 * message, in its box, or in a box of its own over a loose diff's files.
 *
 * It is markdown, drawn as markdown — a test plan has lists and code in it —
 * but commented on like the message is: by line, counted in the markdown
 * source, since that is the text the program wrote and will be pointed back
 * into. The renderer already stamps each block with the line it starts on,
 * and the source rides along on the section so that a comment can quote it.
 *
 * The text comes from a program rather than from the reader, and the program
 * may have quoted anyone in it, so raw HTML is shown as text.
 */
function sectionHtml(section) {
  const { html } = renderMarkdown(section.markdown, { rawHtml: false });
  const title = section.title || section.id;
  return (
    `<section class="dv-section" id="dv-section-${escape(section.id)}" data-section="${escape(section.id)}" ` +
    `data-title="${escape(title)}" data-source="${escape(section.markdown)}">` +
    `<header class="dv-file-header"><span class="dv-section-title">${escape(title)}</span></header>` +
    `<div class="dv-section-body">${html}</div>` +
    '</section>'
  );
}

/**
 * Order paths as a tree of their directories reads top to bottom: at each
 * level the directories, then the files, each by name. Git sorts by the whole
 * path, which puts `a/b.js` after `a.js` and before `a/b/c.js`; the list of
 * files stack-viewer draws as a tree would then disagree with the page about
 * which file comes next.
 */
function byTree(a, b) {
  const as = a.split('/');
  const bs = b.split('/');
  for (let i = 0; i < Math.min(as.length, bs.length); i++) {
    if (as[i] === bs[i]) continue;
    const aIsFile = i === as.length - 1;
    const bIsFile = i === bs.length - 1;
    if (aIsFile !== bIsFile) return aIsFile ? 1 : -1;
    return as[i] < bs[i] ? -1 : 1;
  }
  return as.length - bs.length;
}

/**
 * Render a unified diff.
 *
 * `sections` are blocks of markdown to show between the commit message and
 * the files, each `{id, title, markdown}`.
 *
 * `versions`, by the path a file is named by, are the file's versions where
 * the caller could read them (see fileHtml): `{newOid, newText}`.
 * The page then offers more of each file's unchanged lines than the patch
 * carries, from the new text, which comes back in `blobs` by blob id for the
 * page to carry. `cache` keeps the files highlighted across calls, for a
 * caller rendering several commits that share them.
 * @returns {{html: string, files: number, additions: number, deletions: number,
 *   blobs: Map<string, {html?: string[], text?: string[]}>}}
 */
export function renderDiff(source, { sections = [], versions = null, cache = null } = {}) {
  const { message, patch } = splitCommitMessage(source);
  const files = parseDiff(patch).sort((a, b) => byTree(commentPath(a), commentPath(b)));
  const stats = {
    files: files.length,
    additions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
  };
  // A commit's sections are part of what it says, so they go in its message's
  // box, under it, as Phabricator's test plan does.
  const extra = sections.map(sectionHtml).join('');
  const head = message ? messageHtml(message, stats, extra) : extra;
  // The files are one box, as on Phabricator, each running into the next.
  const blobs = new Map();
  const body = files.length
    ? `<div class="dv-files">${files
        .map((file, i) => fileHtml(file, i, versions?.[commentPath(file)], cache, blobs))
        .join('\n')}</div>`
    : '<div class="dv-empty-diff">This diff has no file changes.</div>';
  return {
    html: head + body,
    // Whether the page opens on a commit's message, whose bar already says
    // what the commit is and how large.
    commit: Boolean(message),
    message: message?.body || null,
    ...stats,
    // Each file's path and status, in the order of the sections, whose ids
    // are `dv-file-` and the index into this.
    paths: files.map((file) => ({ path: commentPath(file), status: statusOf(file) })),
    blobs,
  };
}

/**
 * The files a patch changes, as the renderer names them, with the paths of
 * both versions — what a caller reads the versions by before rendering.
 * @returns {{path: string, from: string|null, to: string|null}[]}
 */
export function diffFiles(source) {
  const { patch } = splitCommitMessage(source);
  const real = (name) => (name && name !== '/dev/null' ? name : null);
  return parseDiff(patch).map((file) => ({
    path: commentPath(file),
    from: file.new ? null : real(file.from),
    to: file.deleted ? null : real(file.to),
  }));
}

/**
 * Guess whether some text is a diff, from the markers a unified diff has to
 * carry. Used to let the viewer accept a file without being told what it is.
 *
 * Fenced code blocks are skipped: a document that shows a patch in a ```diff
 * block is a document about a patch, and reading it as one would throw away
 * every word around it. Markdown is the only format this has to be careful
 * about, since it is the only one the caller would otherwise render.
 */
export function looksLikeDiff(source) {
  const head = source.slice(0, 8192).split('\n', 200);
  let fence = null;
  for (let i = 0; i < head.length; i++) {
    const line = head[i];

    // ``` or ~~~, any length from three up; the same run has to close it.
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) {
        fence = marker[1][0].repeat(3);
        continue;
      }
      if (marker[1].startsWith(fence)) {
        fence = null;
      }
      continue;
    }
    if (fence) {
      continue;
    }

    if (/^diff --git /.test(line) || /^Index: /.test(line)) return true;
    // A --- / +++ / @@ trio is the minimum a bare unified diff can have.
    if (/^--- /.test(line) && /^\+\+\+ /.test(head[i + 1] || '') && /^@@ /.test(head[i + 2] || '')) {
      return true;
    }
  }
  return false;
}
