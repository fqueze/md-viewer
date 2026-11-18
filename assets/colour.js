/**
 * Syntax colours for a diff page, added in the browser once the page is shown.
 *
 * The page comes with its lines as text, the changed words already marked,
 * and each file's languages on its section (`data-lang-old`, `data-lang-new`,
 * by highlight.js's names). highlight.js is the page's own `window.hljs`, or
 * in stack-viewer the stack page's, which loads it once for every commit.
 *
 * A line on its own has lost whatever opened before it, so a comment or a
 * string that spans lines would come out coloured as code: each version's
 * lines of a hunk are highlighted together, the most the patch knows of the
 * file. The colours
 * are laid over the line's text as it is, inside the marks already there,
 * so nothing a review comment anchors on moves.
 */
(function () {
  'use strict';

  /** Past this much text, a hunk stays plain: a generated file or a lockfile is not read for its syntax. */
  var MAX_CHARS = 200000;
  /** How long a stretch of colouring may hold the page before it lets it draw. */
  var SLICE_MS = 12;

  function highlighter() {
    if (window.hljs) return window.hljs;
    try {
      return window.parent !== window ? window.parent.hljs : null;
    } catch (error) {
      // A parent of another origin.
      return null;
    }
  }

  var hljs = highlighter();
  if (!hljs) {
    document.documentElement.dataset.coloured = '1';
    return;
  }

  var ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#x27;': "'" };

  /**
   * Lines highlighted as one text, cut back into lines: each a list of
   * tokens, its text and the classes it sits in, outermost first. Null when
   * the language is not loaded, the text is too long, or the highlighting
   * does not give back the text it was given.
   */
  function tokensOf(lines, language) {
    var source = lines.join('\n');
    if (!language || !hljs.getLanguage(language) || !lines.length || source.length > MAX_CHARS) return null;
    var html;
    try {
      html = hljs.highlight(source, { language: language, ignoreIllegals: true }).value;
    } catch (error) {
      return null;
    }
    var result = [[]];
    var stack = [];
    var re = /<span class="([^"]*)">|(<\/span>)|([^<]+)/g;
    var m;
    while ((m = re.exec(html))) {
      if (m[1] !== undefined) {
        stack.push(m[1]);
      } else if (m[2]) {
        stack.pop();
      } else {
        var pieces = m[3].replace(/&(?:amp|lt|gt|quot|#x27);/g, function (e) {
          return ENTITIES[e];
        }).split('\n');
        for (var i = 0; i < pieces.length; i++) {
          if (i) result.push([]);
          if (pieces[i]) result[result.length - 1].push({ text: pieces[i], classes: stack.slice() });
        }
      }
    }
    if (result.length !== lines.length) return null;
    for (var k = 0; k < lines.length; k++) {
      if (textOf(result[k]) !== lines[k]) return null;
    }
    return result;
  }

  function textOf(tokens) {
    var text = '';
    for (var i = 0; i < tokens.length; i++) text += tokens[i].text;
    return text;
  }

  /** A piece of text in the classes it sits in. */
  function wrapped(text, classes) {
    var node = document.createTextNode(text);
    for (var i = classes.length - 1; i >= 0; i--) {
      var span = document.createElement('span');
      span.className = classes[i];
      span.appendChild(node);
      node = span;
    }
    return node;
  }

  /**
   * Lay a line's tokens over the text of `cell`: each of its text nodes is
   * cut where the tokens are and each piece wrapped in its classes, inside
   * whatever already holds it (a changed word, a comment's highlight).
   */
  function paint(cell, tokens) {
    if (!cell || !tokens || cell.dataset.coloured) return;
    if (textOf(tokens) !== cell.textContent) return;
    var walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) nodes.push(node);
    var t = 0;
    var into = 0;
    for (var i = 0; i < nodes.length; i++) {
      var text = nodes[i].data;
      var fragment = document.createDocumentFragment();
      while (text) {
        var token = tokens[t];
        var take = Math.min(text.length, token.text.length - into);
        fragment.appendChild(wrapped(text.slice(0, take), token.classes));
        text = text.slice(take);
        into += take;
        if (into === token.text.length) {
          t++;
          into = 0;
        }
      }
      nodes[i].parentNode.replaceChild(fragment, nodes[i]);
    }
    cell.dataset.coloured = '1';
  }

  /** The text of a line's code: spelled out where its spaces are, so from the page then. */
  function sourceOf(line) {
    return line.dataset.src != null ? line.dataset.src : line.querySelector('.dv-text').textContent;
  }

  /** A run of lines of one version, highlighted together; `cells` are where each is drawn. */
  function colourRun(run, language) {
    var tokens = tokensOf(run.texts, language);
    if (!tokens) return;
    for (var i = 0; i < run.cells.length; i++) {
      if (run.cells[i]) paint(run.cells[i], tokens[i]);
    }
  }

  /**
   * A file's hunks: each version's lines of a hunk highlighted together. The
   * old version's are the deletions and the unchanged lines, the new one's
   * the insertions and the unchanged lines' mirrored copies, side by side: a
   * change above can open or close a comment, after which the same text is
   * code in one file and prose in the other.
   */
  function colourFile(section) {
    var oldLanguage = section.dataset.langOld;
    var newLanguage = section.dataset.langNew;
    if (!oldLanguage && !newLanguage) return;
    var old = run();
    var now = run();
    function run() {
      return { texts: [], cells: [] };
    }
    function flush() {
      colourRun(old, oldLanguage);
      colourRun(now, newLanguage);
      old = run();
      now = run();
    }
    var rows = section.querySelectorAll('.dv-row-hunk, .dv-line:not(.dv-line-mirror)');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.classList.contains('dv-row-hunk')) {
        flush();
        continue;
      }
      var side = row.dataset.side;
      var text = sourceOf(row);
      // A line whose spaces are spelled out keeps them: they are its point.
      var cell = row.dataset.src != null ? null : row.querySelector('.dv-text');
      if (side === 'del' || side === 'ctx') {
        old.texts.push(text);
        old.cells.push(cell);
      }
      if (side === 'add' || side === 'ctx') {
        var mirror = side === 'ctx' ? row.nextElementSibling : null;
        now.texts.push(text);
        now.cells.push(side === 'add' ? cell : mirror && mirror.classList.contains('dv-line-mirror') ? mirror.querySelector('.dv-text') : null);
      }
    }
    flush();
  }

  /**
   * Every file, a few at a time: the page draws between slices, so a long
   * commit is readable at once and its colours arrive as they are made.
   */
  function colourAll() {
    var sections = document.querySelectorAll('.dv-file[data-lang-old], .dv-file[data-lang-new]');
    var next = 0;
    function slice() {
      var start = Date.now();
      while (next < sections.length && Date.now() - start < SLICE_MS) colourFile(sections[next++]);
      if (next < sections.length) setTimeout(slice, 0);
      else {
        document.documentElement.dataset.coloured = '1';
        document.dispatchEvent(new CustomEvent('mdv-coloured'));
      }
    }
    slice();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', colourAll);
  else colourAll();
})();
