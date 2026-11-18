/**
 * Annotations — what the program driving this page says about its commit,
 * drawn onto the page: a status on the message's bar, links in the message,
 * and controls that act on the commit.
 *
 * The page does not know what any of it means. A control that is used is
 * announced to the top window, which is the program's own page — in
 * stack-viewer the stack around this frame, in diff-viewer this page — as
 *
 *   window.dispatchEvent(new CustomEvent('mdv-action', { detail: { commit, id, value } }))
 *
 * and nothing else happens here. The program acts, and may answer with
 * `mdvSetAnnotations(sha, annotation)`, which redraws all of it in place.
 *
 * It also shows the comments already made on the commit — on Phabricator, by
 * a reviewing agent, by the reader on an earlier version — each on the line
 * it was made on, with the responses the program offers: mark it done, say it
 * will be addressed or ignored, reply. What the reader does with them is read
 * back with `mdvReviewResponses()`.
 */
(function () {
  'use strict';

  var root = document.getElementById('mdv-root');
  var article = document.getElementById('mdv-content');
  var sha = root.dataset.commit || '';
  var annotation = JSON.parse(document.getElementById('mdv-annotation').textContent) || {};

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** An element with a class and, optionally, text. */
  function element(tag, className, text) {
    var el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  /** A word fit for a class name, from a kind the program wrote. */
  function kindOf(kind) {
    return String(kind || '').toLowerCase().replace(/[^a-z0-9-]/g, '') || 'none';
  }

  /** Only links that go somewhere on the web; anything else is left as text. */
  function safeHref(href) {
    return /^(https?:|mailto:)/i.test(href || '') ? href : null;
  }

  /** Whether a sha names this page's commit, by prefix either way. */
  function isThisCommit(other) {
    if (!other) return false;
    if (!sha) return true;
    return other.indexOf(sha) === 0 || sha.indexOf(other) === 0;
  }

  // ---------------------------------------------------------------------------
  // The bar
  // ---------------------------------------------------------------------------

  /**
   * The bar over the commit message, where the status and the controls go:
   * they are about the commit, and that bar is the one that names it. A
   * loose diff has no message, so it gets a bar of its own at the top.
   */
  function bar() {
    var header = article.querySelector('.dv-message > .dv-file-header');
    if (header) return header;
    header = article.querySelector('.mdv-annot-bar');
    if (header) return header;
    header = element('div', 'dv-file-header mdv-annot-bar');
    article.insertBefore(header, article.firstChild);
    return header;
  }

  /**
   * The status, under the message's first line, as Phabricator has it under
   * a revision's title; on a loose diff's bar, which has no title. Marked as
   * an aside, as everything drawn here is: review.js leaves asides out of the
   * text it anchors comments in, so drawing and redrawing them never moves a
   * comment.
   */
  function drawStatus() {
    var old = article.querySelector('.mdv-badge-row') || article.querySelector('.mdv-badge');
    if (old) old.remove();
    var status = annotation.status;
    if (!status || !status.label) return;
    var badge = element('span', 'mdv-badge mdv-badge-' + kindOf(status.kind) + ' mdv-aside', status.label);
    if (status.tooltip) badge.title = status.tooltip;
    var title = article.querySelector('.dv-line-msg[data-msg-line="1"]');
    if (title) {
      var row = element('div', 'mdv-badge-row mdv-aside');
      row.appendChild(badge);
      title.parentNode.insertBefore(row, title.nextSibling);
      return;
    }
    var header = bar();
    var id = header.querySelector('.dv-msg-sha');
    header.insertBefore(badge, id ? id.nextSibling : header.firstChild);
  }

  /**
   * A program's panels (`panels`), each a box under the message's title —
   * the status's line when there is one — as a program's own page would show
   * a thing to do about the commit, such as a bug to file: a title, linked
   * when it has an `href`; its `markdown`; `details`, each folded under its
   * label, with a button copying its text when `copy`; and an `input`, a
   * field with a button, which fires its `id` with what was typed (Enter
   * does too). A redraw keeps what is being typed, and the folds open.
   */
  function drawPanels() {
    var typed = {};
    var open = {};
    var olds = article.querySelectorAll('.mdv-panels');
    for (var o = 0; o < olds.length; o++) {
      var fields = olds[o].querySelectorAll('.mdv-panel-input input');
      for (var f = 0; f < fields.length; f++) typed[fields[f].dataset.action] = fields[f].value;
      var folds = olds[o].querySelectorAll('details[data-fold]');
      for (var d = 0; d < folds.length; d++) open[folds[d].dataset.fold] = folds[d].open;
      olds[o].remove();
    }
    var panels = annotation.panels || [];
    if (!panels.length) return;
    var box = element('div', 'mdv-panels mdv-aside');
    for (var i = 0; i < panels.length; i++) {
      var panel = panels[i] || {};
      var node = element('div', 'mdv-panel mdv-panel-' + kindOf(panel.tone));
      if (panel.title) {
        var title = element('div', 'mdv-panel-title');
        var href = safeHref(panel.href);
        if (href) {
          var a = element('a', 'mdv-panel-link', panel.title);
          a.href = href;
          a.target = '_blank';
          a.rel = 'noopener';
          if (panel.tooltip) a.title = panel.tooltip;
          title.appendChild(a);
        } else {
          title.textContent = panel.title;
        }
        node.appendChild(title);
      }
      if (panel.markdown) {
        var text = element('div', 'mdv-panel-text');
        text.innerHTML = markdownHtml(panel.markdown);
        node.appendChild(text);
      }
      var details = panel.details || [];
      for (var k = 0; k < details.length; k++) {
        var detail = details[k] || {};
        var fold = element('details', 'mdv-panel-detail');
        fold.dataset.fold = (panel.id || i) + ':' + k;
        fold.open = Boolean(open[fold.dataset.fold]);
        var summary = element('summary', null, detail.label || '');
        if (detail.copy) {
          var copy = element('button', 'mdv-panel-copy', 'Copy');
          copy.type = 'button';
          copy.dataset.copy = String(detail.markdown || '');
          summary.appendChild(copy);
        }
        fold.appendChild(summary);
        var body = element('div', 'mdv-panel-detail-body');
        body.innerHTML = markdownHtml(detail.markdown);
        fold.appendChild(body);
        node.appendChild(fold);
      }
      var input = panel.input;
      if (input && input.id != null) {
        var row = element('div', 'mdv-panel-input');
        var field = element('input');
        field.type = 'text';
        field.dataset.action = String(input.id);
        if (input.placeholder) field.placeholder = input.placeholder;
        if (typed[input.id] != null) field.value = typed[input.id];
        row.appendChild(field);
        var send = element('button', 'mdv-panel-send', input.button || 'Send');
        send.type = 'button';
        send.dataset.action = String(input.id);
        row.appendChild(send);
        node.appendChild(row);
      }
      box.appendChild(node);
    }
    var badge = article.querySelector('.mdv-badge-row');
    var title = badge || article.querySelector('.dv-line-msg[data-msg-line="1"]');
    if (title) title.parentNode.insertBefore(box, title.nextSibling);
    else article.insertBefore(box, article.firstChild);
  }

  function sendPanel(id) {
    var field = article.querySelector('.mdv-panel-input input[data-action="' + id + '"]');
    if (!field || !field.value.trim()) return;
    fire(id, field.value.trim());
    field.value = '';
  }

  document.addEventListener('click', function (event) {
    var send = event.target.closest && event.target.closest('.mdv-panel-send');
    if (send) return sendPanel(send.dataset.action);
    var copy = event.target.closest && event.target.closest('.mdv-panel-copy');
    if (!copy) return;
    // In the summary: copying does not fold the details open or shut.
    event.preventDefault();
    navigator.clipboard.writeText(copy.dataset.copy).then(function () {
      copy.classList.add('mdv-copied');
      setTimeout(function () {
        copy.classList.remove('mdv-copied');
      }, 1200);
    });
  });

  document.addEventListener('keydown', function (event) {
    var field = event.target.closest && event.target.closest('.mdv-panel-input input');
    if (!field || event.key !== 'Enter') return;
    event.preventDefault();
    sendPanel(field.dataset.action);
  });

  /** Where actions for after the whole commit was read go (`at: "end"`): the end of the page. */
  function end() {
    var place = document.querySelector('.mdv-annot-end');
    if (place) return place;
    place = element('div', 'mdv-annot-end');
    article.parentNode.insertBefore(place, article.nextSibling);
    return place;
  }

  /**
   * The controls, before the size of the diff at the far end of the bar. A
   * button fires when clicked; a text field when Enter is pressed in it, with
   * what was typed.
   *
   * A redraw keeps what is being typed into a field, and the focus in it: the
   * program may well redraw the bar because of some other control, and that
   * should not wipe out the bug number half typed into this one.
   */
  function drawActions() {
    var typed = {};
    var focused = null;
    var olds = document.querySelectorAll('.mdv-actions');
    for (var o = 0; o < olds.length; o++) {
      var inputs = olds[o].querySelectorAll('input');
      for (var i = 0; i < inputs.length; i++) {
        typed[inputs[i].dataset.action] = inputs[i].value;
        if (document.activeElement === inputs[i]) focused = inputs[i].dataset.action;
      }
      olds[o].remove();
    }
    var actions = annotation.actions || [];
    if (!actions.length) return;

    var box = element('span', 'mdv-actions mdv-aside');
    var last = element('span', 'mdv-actions mdv-actions-end mdv-aside');
    for (var j = 0; j < actions.length; j++) {
      var action = actions[j];
      if (!action || action.id == null) continue;
      var into = action.at === 'end' ? last : box;
      var id = String(action.id);
      if (action.kind === 'input') {
        var label = element('label', 'mdv-action mdv-action-input');
        if (action.label) label.appendChild(element('span', null, action.label));
        var input = element('input');
        input.type = 'text';
        input.dataset.action = id;
        if (action.placeholder) input.placeholder = action.placeholder;
        if (typed[id] != null) input.value = typed[id];
        label.appendChild(input);
        into.appendChild(label);
      } else {
        var button = element('button', 'mdv-action mdv-action-button', action.label || id);
        button.type = 'button';
        button.dataset.action = id;
        if (action.tone === 'positive') button.classList.add('mdv-action-positive');
        if (action.disabled) button.disabled = true;
        into.appendChild(button);
      }
      if (action.tooltip) into.lastChild.title = action.tooltip;
    }

    if (box.firstChild) {
      var header = bar();
      header.insertBefore(box, header.querySelector('.dv-summary'));
    }
    if (last.firstChild) end().appendChild(last);
    if (focused != null) {
      var fields = document.querySelectorAll('.mdv-actions input');
      for (var k = 0; k < fields.length; k++) {
        if (fields[k].dataset.action === focused) fields[k].focus();
      }
    }
  }

  /**
   * Tell the top window a control was used. The detail is rebuilt in that
   * window's own realm, so the program can keep it however long it likes
   * without holding on to an object of this frame's.
   */
  function fire(id, value) {
    var top = window.top;
    var detail = top.JSON.parse(JSON.stringify({ commit: sha, id: id, value: value }));
    top.dispatchEvent(new top.CustomEvent('mdv-action', { detail: detail }));
  }

  // On the document: the actions at the end are after the article.
  document.addEventListener('click', function (event) {
    var button = event.target.closest && event.target.closest('.mdv-action-button');
    if (button) fire(button.dataset.action, undefined);
  });

  /**
   * A title link followed — by a click, or a middle click opening a tab — is
   * announced to the top window too, as `mdv-link` {commit, text, href}: the
   * program may want to know which page the reader went to, say to look for
   * the bug they filed there once they come back. The link is followed as
   * usual.
   */
  function linkFollowed(event) {
    // A panel's title link too.
    var a = event.target.closest && event.target.closest('a.mdv-title-link, a.mdv-panel-link');
    if (!a || event.button > 1) return;
    var top = window.top;
    var detail = top.JSON.parse(JSON.stringify({ commit: sha, text: a.textContent, href: a.href }));
    top.dispatchEvent(new top.CustomEvent('mdv-link', { detail: detail }));
  }
  article.addEventListener('click', linkFollowed);
  article.addEventListener('auxclick', linkFollowed);
  document.addEventListener('keydown', function (event) {
    var input = event.target.closest && event.target.closest('.mdv-action-input input');
    if (!input || event.key !== 'Enter') return;
    event.preventDefault();
    fire(input.dataset.action, input.value);
  });

  // ---------------------------------------------------------------------------
  // Title links
  // ---------------------------------------------------------------------------

  /**
   * Make the first occurrence of `text` under `scope` a link. It has to sit in
   * one text node, which is how a title reads; a link the message already has
   * over exactly that text — a bug number — is pointed at the new place
   * instead, keeping where it went before so a redraw can put it back.
   */
  function linkFirst(scope, link) {
    var href = safeHref(link.href);
    if (!link.text || !href) return;
    var walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      var at = node.textContent.indexOf(link.text);
      if (at === -1) continue;
      var existing = node.parentElement.closest('a');
      if (existing && existing.textContent === link.text) {
        if (!existing.dataset.mdvHref) {
          existing.dataset.mdvHref = existing.getAttribute('href') || '';
          existing.dataset.mdvTitle = existing.getAttribute('title') || '';
        }
        existing.href = href;
        existing.classList.add('mdv-title-link');
        if (link.tooltip) existing.title = link.tooltip;
        relabel(existing, link);
        return;
      }
      if (existing) continue;
      var a = element('a', 'mdv-title-link');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      if (link.tooltip) a.title = link.tooltip;
      var rest = node.splitText(at);
      rest.splitText(link.text.length);
      rest.parentNode.replaceChild(a, rest);
      a.appendChild(rest);
      relabel(a, link);
      return;
    }
  }

  /**
   * A link's own words in place of the text it was found by (`label`): kept to
   * be put back by unlinkAll; and its `tone`, `attention` drawing it in red.
   */
  function relabel(a, link) {
    if (link.tone) a.classList.add('mdv-title-link-' + kindOf(link.tone));
    if (link.label == null) return;
    if (a.dataset.mdvText == null) a.dataset.mdvText = a.textContent;
    a.textContent = String(link.label);
  }

  /** Undo every title link, leaving the message as the renderer drew it. */
  function unlinkAll(scope) {
    var links = scope.querySelectorAll('a.mdv-title-link');
    for (var i = 0; i < links.length; i++) {
      var a = links[i];
      if (a.dataset.mdvText != null) {
        a.textContent = a.dataset.mdvText;
        delete a.dataset.mdvText;
      }
      if (a.dataset.mdvHref != null) {
        a.setAttribute('href', a.dataset.mdvHref);
        if (a.dataset.mdvTitle) a.setAttribute('title', a.dataset.mdvTitle);
        else a.removeAttribute('title');
        a.className = a.className.replace(/\bmdv-title-link\S*/g, '').trim();
        delete a.dataset.mdvHref;
        delete a.dataset.mdvTitle;
      } else {
        var parent = a.parentNode;
        while (a.firstChild) parent.insertBefore(a.firstChild, a);
        parent.removeChild(a);
        parent.normalize();
      }
    }
  }

  function drawTitleLinks() {
    var message = article.querySelector('.dv-msg-table');
    if (!message) return;
    unlinkAll(message);
    var links = annotation.titleLinks || [];
    for (var i = 0; i < links.length; i++) {
      if (links[i]) linkFirst(message, links[i]);
    }
  }

  // ---------------------------------------------------------------------------
  // Earlier comments: their text
  // ---------------------------------------------------------------------------

  function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /**
   * One line of a comment's markdown: code spans, links, bold and italics.
   * Everything is escaped first, so nothing a commenter wrote becomes markup
   * except what is made here; code spans are set aside first, so nothing in
   * them is read as markdown either.
   */
  function inlineHtml(text) {
    var codes = [];
    var html = escapeHtml(text).replace(/`([^`]+)`/g, function (match, code) {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    html = html
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, function (match, label, href) {
        return '<a href="' + href + '" target="_blank" rel="noopener">' + label + '</a>';
      })
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?])/g, function (match, before, href) {
        return before + '<a href="' + href + '" target="_blank" rel="noopener">' + href + '</a>';
      })
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^\w*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
      .replace(/(^|[^\w])_([^_\s][^_]*)_(?!\w)/g, '$1<em>$2</em>');
    return html.replace(/\u0000(\d+)\u0000/g, function (match, n) {
      return codes[Number(n)];
    });
  }

  /**
   * A comment's body as HTML. Comments are short, and come from Phabricator
   * and from agents as often as from markdown proper, so this reads the part
   * of markdown they use — paragraphs whose line breaks are kept, lists,
   * quotes and fenced code — rather than carrying a whole markdown parser into
   * every commit's page.
   */
  function markdownHtml(text) {
    var lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    var out = [];
    var para = [];
    var list = null;
    function flush() {
      if (para.length) out.push('<p>' + para.map(inlineHtml).join('<br>') + '</p>');
      para = [];
      if (list) out.push('<' + list.tag + '>' + list.items.join('') + '</' + list.tag + '>');
      list = null;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var fence = /^\s*(```+|~~~+)/.exec(line);
      if (fence) {
        flush();
        var code = [];
        for (i++; i < lines.length && lines[i].trim().indexOf(fence[1]) !== 0; i++) code.push(lines[i]);
        out.push('<pre><code>' + escapeHtml(code.join('\n')) + '</code></pre>');
        continue;
      }
      if (!line.trim()) {
        flush();
        continue;
      }
      var item = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line);
      if (item) {
        var tag = item[1] ? 'ul' : 'ol';
        if (para.length || (list && list.tag !== tag)) flush();
        if (!list) list = { tag: tag, items: [] };
        list.items.push('<li>' + inlineHtml(item[3]) + '</li>');
        continue;
      }
      var quote = /^\s*>\s?(.*)$/.exec(line);
      if (quote) {
        flush();
        out.push('<blockquote>' + inlineHtml(quote[1]) + '</blockquote>');
        continue;
      }
      if (list) flush();
      para.push(line);
    }
    flush();
    return out.join('');
  }

  /** When a comment was made, briefly: `Nov 17, 9:57 AM`. */
  function dateText(date) {
    var when = new Date(date);
    if (!date || isNaN(when.getTime())) return date ? String(date) : '';
    return when.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  /** `line 12`, or `lines 12–15`. */
  function numbersText(line) {
    if (Array.isArray(line)) return line[0] === line[1] ? String(line[0]) : line[0] + '–' + line[1];
    return String(line);
  }

  function linesText(line) {
    if (Array.isArray(line)) return line[0] === line[1] ? 'line ' + line[0] : 'lines ' + line[0] + '–' + line[1];
    return line ? 'line ' + line : '';
  }

  // ---------------------------------------------------------------------------
  // Earlier comments: where they go
  // ---------------------------------------------------------------------------

  /** The line a comment is shown after: the last of a range. */
  function lastLine(line) {
    return Array.isArray(line) ? Number(line[line.length - 1]) : Number(line);
  }

  function byData(selector, name, value) {
    var all = article.querySelectorAll(selector);
    for (var i = 0; i < all.length; i++) {
      if (all[i].dataset[name] === value) return all[i];
    }
    return null;
  }

  /** The file's section on the page, by the path a comment names. */
  function fileSection(path) {
    return byData('.dv-file:not(.dv-message)', 'path', path);
  }

  /**
   * The line of a file a comment is on, among the lines the diff shows: a
   * deletion or an unchanged line for the old version's numbers, an insertion
   * or an unchanged line for the new one's. An unchanged line carries the new
   * number as its own and the old one in its gutter.
   */
  function fileLine(section, number, side) {
    var lines = section.querySelectorAll('.dv-line:not(.dv-line-mirror)');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var kind = line.dataset.side;
      if (side === 'old') {
        if (kind === 'del' && Number(line.dataset.line) === number) return line;
        var old = line.querySelector('.dv-num-old');
        if (kind === 'ctx' && old && Number(old.textContent) === number) return line;
      } else if ((kind === 'add' || kind === 'ctx') && Number(line.dataset.line) === number) {
        return line;
      }
    }
    return null;
  }

  /**
   * The holder for the threads shown after one line. One per line, so that
   * side by side, where a run of changes is a grid with each line placed on
   * its row, every thread of that line shares the one row after it — set by
   * `--dv-row`, as the lines are — across both columns.
   */
  function holderAfter(line, side) {
    var row = line.closest('.dv-row-context');
    var after = row || line;
    // Side by side, a comment is under the version it is on, as on
    // Phabricator: one holder per version after a line.
    var next = after.nextElementSibling;
    while (next && next.classList.contains('mdv-threads')) {
      if ((next.dataset.side || '') === (side || '')) return next;
      after = next;
      next = next.nextElementSibling;
    }
    var holder = element('div', 'mdv-threads mdv-aside');
    if (side) holder.dataset.side = side;
    var number = line.style.getPropertyValue('--dv-row');
    if (number && !row) holder.style.setProperty('--dv-row', number);
    after.parentNode.insertBefore(holder, after.nextSibling);
    return holder;
  }

  /**
   * The holder for comments that are on no line shown here — made on an
   * earlier version, on a line this diff does not show, or on a file it no
   * longer has — between the message and the files, as Phabricator's timeline
   * shows a revision's comments: an entry per author and time, its head
   * saying who and when, then under it each place they were on (a file, the
   * message, a section: `key` names it, `title` heads it; none for the commit
   * as a whole), a row per comment.
   */
  /** The timeline between the message and the files: earlier comments' entries and the history, by date. */
  function timeline() {
    var box = article.querySelector('.mdv-earlier');
    if (!box) {
      box = element('section', 'mdv-earlier mdv-aside');
      article.insertBefore(box, article.querySelector('.dv-files, .dv-empty-diff'));
    }
    return box;
  }

  function earlierHolder(comment, key, title) {
    var box = timeline();
    var who = String(comment.author || 'someone');
    var at = String(comment.date || '');
    var entry = null;
    var entries = box.querySelectorAll('.mdv-earlier-entry');
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].dataset.who === who && entries[i].dataset.at === at) entry = entries[i];
    }
    if (!entry) {
      entry = element('div', 'mdv-earlier-entry');
      entry.dataset.who = who;
      entry.dataset.at = at;
      entry.dataset.when = at;
      var head = element('div', 'mdv-earlier-head');
      head.appendChild(element('span', 'mdv-earlier-who', who));
      head.appendChild(element('span', 'mdv-earlier-did'));
      if (at) {
        var when = element('span', 'mdv-earlier-when', dateText(at));
        when.title = at;
        head.appendChild(when);
      }
      entry.appendChild(head);
      box.appendChild(entry);
    }
    var group = null;
    var groups = entry.querySelectorAll('.mdv-earlier-group');
    for (var j = 0; j < groups.length; j++) {
      if (groups[j].dataset.group === key) group = groups[j];
    }
    if (!group) {
      group = element('div', 'mdv-earlier-group');
      group.dataset.group = key;
      // A path in the code's font, after a file's icon; the message and the sections by name.
      if (title) group.appendChild(element('div', 'mdv-earlier-where' + (key.indexOf('file:') === 0 ? ' mdv-earlier-path' : ''), title));
      group.appendChild(element('div', 'mdv-threads mdv-aside'));
      entry.appendChild(group);
    }
    var inline = entry.querySelector('.mdv-earlier-group:not([data-group="(whole)"])');
    entry.querySelector('.mdv-earlier-did').textContent = inline ? ' added inline comments.' : ' commented.';
    return group.querySelector('.mdv-threads');
  }

  /**
   * Where a comment goes: `{holder, displaced}`, displaced when it is not on
   * its own line — outdated, or on a line this diff does not show — so that
   * the thread says which line it was.
   */
  function placeOf(comment) {
    var anchor = comment.anchor || {};
    var number = lastLine(anchor.line);
    var file = String(anchor.file || '');

    if (file === '(commit)') {
      var line = number && byData('.dv-line-msg', 'msgLine', String(number));
      if (line) return { holder: holderAfter(line), displaced: false };
      return { holder: number ? earlierHolder(comment, '(commit)', 'Commit message') : earlierHolder(comment, '(whole)', null), displaced: true };
    }

    var section = /^\(section:(.*)\)$/.exec(file);
    if (section) {
      var box = byData('.dv-section', 'section', section[1]);
      var block = box && number && blockAt(box, number);
      if (block) return { holder: holderAfterBlock(block), displaced: false };
      return { holder: earlierHolder(comment, file, box ? box.dataset.title : section[1]), displaced: true };
    }

    var target = fileSection(file);
    // An outdated comment too, where the program placed it, as Phabricator shows one made on an older diff.
    var shown = target && number && fileLine(target, number, anchor.side === 'old' ? 'old' : 'new');
    if (shown) return { holder: holderAfter(shown, shown.dataset.side === 'del' || anchor.side === 'old' ? 'old' : 'new'), displaced: false };
    return { holder: earlierHolder(comment, 'file:' + file, file), displaced: true };
  }

  /**
   * The block of a section a line of its markdown falls in: the last of its
   * top-level blocks that starts on or before it.
   */
  function blockAt(box, number) {
    var body = box.querySelector('.dv-section-body');
    var found = null;
    for (var child = body.firstElementChild; child; child = child.nextElementSibling) {
      var start = Number(child.dataset.line);
      if (!start) continue;
      if (start > number) break;
      found = child;
    }
    return found;
  }

  function holderAfterBlock(block) {
    var next = block.nextElementSibling;
    if (next && next.classList.contains('mdv-threads')) return next;
    var holder = element('div', 'mdv-threads mdv-aside');
    block.parentNode.insertBefore(holder, block.nextSibling);
    return holder;
  }

  // ---------------------------------------------------------------------------
  // Earlier comments: responding
  // ---------------------------------------------------------------------------

  /**
   * What the reader did to each earlier comment, by id: the latest response,
   * and the text of a reply when one has been written. A reply's text rides
   * along with whatever the response is, since marking a comment done after
   * answering it should not throw the answer away.
   * @type {Object<string, {response: string, text?: string}>}
   */
  var responses = {};
  /** Responses the program has taken (see mdvReviewMarkSent), by id: shown,
   *  and no longer changeable or read out. */
  var sent = {};

  /** The state a comment would be in after the reader's response. */
  function stateOf(comment) {
    var mine = responses[comment.id] || sent[comment.id];
    var response = mine && mine.response;
    if (response === 'done') return 'done';
    if (response === 'address') return 'addressed';
    if (response === 'ignore') return 'ignored';
    if (response === 'reopen') return 'open';
    return comment.state || 'open';
  }

  /**
   * Respond to a comment, or with null take back the response — leaving the
   * reply's text, if any, as a reply.
   */
  function respond(comment, response) {
    var mine = responses[comment.id] || {};
    var text = mine.text;
    if (response) {
      responses[comment.id] = text ? { response: response, text: text } : { response: response };
    } else if (text) {
      responses[comment.id] = { response: 'reply', text: text };
    } else {
      delete responses[comment.id];
    }
    changed(comment);
  }

  /** Set the reply's text, keeping the response it goes with. */
  function reply(comment, text) {
    var mine = responses[comment.id];
    if (text) {
      responses[comment.id] = { response: mine ? mine.response : 'reply', text: text };
    } else if (mine && mine.response !== 'reply') {
      responses[comment.id] = { response: mine.response };
    } else {
      delete responses[comment.id];
    }
    changed(comment, true);
  }

  /**
   * Toggle a response. Done: on is the response, off goes back to how the
   * comment came — or, for a comment that came done, reopens it; back to the
   * state it came in is no response at all.
   */
  function toggle(comment, response, state, on) {
    // Address and Ignore ask for it now, whatever the program says was done before: pressed, they're the response;
    // released, there's none.
    if (response !== 'done') return respond(comment, on ? response : null);
    var came = comment.state === state;
    if (on) respond(comment, came ? null : response);
    else respond(comment, came ? 'reopen' : null);
  }

  /** Redraw one thread after a response, and tell the page. */
  function changed(comment, typing) {
    // A reply being typed is redrawn by the typing itself; redrawing the
    // thread would take the text box out from under the caret.
    if (!typing) {
      var thread = threadOf(comment.id);
      if (thread) thread.replaceWith(threadHtml(comment, thread.mdvDisplaced));
    }
    document.dispatchEvent(new CustomEvent('mdv-responses-change', { detail: { count: Object.keys(responses).length } }));
  }

  function threadOf(id) {
    var threads = article.querySelectorAll('.mdv-thread');
    for (var i = 0; i < threads.length; i++) {
      if (threads[i].dataset.comment === id) return threads[i];
    }
    return null;
  }

  function findComment(id) {
    var list = annotation.comments || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && String(list[i].id) === id) return list[i];
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Earlier comments: the thread
  // ---------------------------------------------------------------------------

  // What a comment's state is called: as the program says it is (addressed: by the change it asked for), or after the
  // reader's response, not sent yet or sent (addressed: asked for).
  var STATE_WORDS = { done: 'Done', addressed: 'Addressed', ignored: 'Ignored', open: 'Open' };
  var RESPONSE_WORDS = { done: 'Done', addressed: 'To address', ignored: 'Ignored', open: 'Reopened' };

  /**
   * One comment as a thread, as Phabricator draws an inline comment: who
   * wrote it and when, where it was if it is no longer there, its state on
   * the right, its text, and the controls the program offered for it.
   *
   * A comment that is not open has been dealt with: its text is greyed, and
   * its head says how, on the right — a Done checkbox where the program lets
   * the reader mark it done, otherwise the state as text.
   */
  function threadHtml(comment, displaced) {
    var state = stateOf(comment);
    var thread = element('div', 'mdv-thread mdv-thread-' + kindOf(state));
    thread.dataset.comment = String(comment.id);
    thread.mdvDisplaced = displaced;
    if (comment.outdated) thread.classList.add('mdv-thread-outdated');
    var offered = comment.responses || [];
    var mine = responses[comment.id] || sent[comment.id] || {};

    // Away from its line, its entry in the Earlier comments says who and when.
    var head = element('div', 'mdv-thread-head');
    if (!displaced) {
      head.appendChild(element('span', 'mdv-thread-author', comment.author || 'someone'));
      if (comment.date) {
        var when = element('span', 'mdv-thread-date', dateText(comment.date));
        when.title = String(comment.date);
        head.appendChild(when);
      }
    }
    var anchor = comment.anchor || {};
    // Away from its line, in the Earlier comments box, its line is in a gutter
    // of its own, as Phabricator's timeline has it (its group says where); a
    // comment on the commit as a whole (a reviewer's general one) was never on
    // a line.
    if (displaced && anchor.line) {
      var gutter = element('span', 'mdv-thread-line', '↪ ' + numbersText(anchor.line));
      gutter.title =
        (anchor.side === 'old' ? 'old ' : '') +
        linesText(anchor.line) +
        (comment.outdated ? ' of the version it was made on' : ', not shown in this diff');
      thread.appendChild(gutter);
      thread.classList.add('mdv-thread-lined');
    }
    // On its line but made on an earlier version, which its quoted lines show.
    if (comment.outdated && !displaced) {
      var older = element('span', 'mdv-thread-older', '⏮ on an earlier version');
      older.title = 'Made on an earlier version of the commit, whose lines it was on are quoted below';
      head.appendChild(older);
    }
    if (sent[comment.id]) head.appendChild(element('span', 'mdv-thread-sent', 'response sent'));
    var end = element('span', 'mdv-thread-end');
    var source = safeHref(comment.sourceUrl);
    if (source) {
      var link = element('a', 'mdv-thread-source', 'source');
      link.href = source;
      link.target = '_blank';
      link.rel = 'noopener';
      end.appendChild(link);
    }
    // Reply in the head, as a link: double-clicking the comment does it too.
    if (offered.indexOf('reply') !== -1) {
      var replyLink = element('button', 'mdv-respond mdv-respond-reply', 'Reply');
      replyLink.type = 'button';
      replyLink.dataset.respond = 'reply';
      replyLink.title = 'Reply (or double-click the comment)';
      if (sent[comment.id]) replyLink.disabled = true;
      end.appendChild(replyLink);
    }
    if (offered.indexOf('done') !== -1) {
      var label = element('label', 'mdv-respond mdv-respond-done');
      var box = element('input');
      box.type = 'checkbox';
      box.checked = state === 'done';
      box.dataset.respond = 'done';
      if (sent[comment.id]) box.disabled = true;
      label.appendChild(box);
      label.appendChild(document.createTextNode(' Done'));
      end.appendChild(label);
    } else if (state !== 'open') {
      var words = mine.response ? RESPONSE_WORDS : STATE_WORDS;
      // A tick for what was done, not for what the reader asks for.
      var tick = !mine.response && (state === 'done' || state === 'addressed') ? '✓ ' : '';
      end.appendChild(element('span', 'mdv-thread-state', tick + (words[state] || state)));
    }
    head.appendChild(end);
    thread.appendChild(head);

    // The lines it was made on, in the version it was made on, when they changed since.
    var context = comment.outdated && Array.isArray(comment.context) ? comment.context : [];
    if (context.length) {
      var quote = element('div', 'mdv-thread-context');
      for (var c = 0; c < context.length; c++) {
        var at = context[c] || {};
        var row = element('div', 'mdv-thread-context-line' + (at.here ? ' mdv-thread-context-here' : ''));
        row.appendChild(element('span', 'mdv-thread-context-n', at.n != null ? String(at.n) : ''));
        row.appendChild(element('span', 'mdv-thread-context-text', String(at.text || '')));
        quote.appendChild(row);
      }
      thread.appendChild(quote);
    }

    var body = element('div', 'mdv-thread-body');
    body.innerHTML = markdownHtml(comment.body);
    thread.appendChild(body);

    // Under the text: in a row of the Earlier comments, kept together, beside the line's gutter.
    var more = displaced ? element('div', 'mdv-thread-more') : thread;
    // The answers it got, each saying who and when.
    var replies = Array.isArray(comment.replies) ? comment.replies : [];
    for (var r = 0; r < replies.length; r++) {
      var answer = replies[r] || {};
      var box = element('div', 'mdv-thread-reply');
      var who = element('div', 'mdv-thread-reply-head');
      who.appendChild(element('span', 'mdv-thread-author', answer.author || 'someone'));
      if (answer.date) {
        var at = element('span', 'mdv-thread-date', dateText(answer.date));
        at.title = String(answer.date);
        who.appendChild(at);
      }
      box.appendChild(who);
      var said = element('div', 'mdv-thread-reply-body');
      said.innerHTML = markdownHtml(answer.body);
      box.appendChild(said);
      more.appendChild(box);
    }
    // The program's draft answer, shown as it would be sent, until the reader opens it with Reply to change it.
    if (comment.draftReply && mine.text == null) {
      var draft = element('div', 'mdv-thread-draft');
      draft.appendChild(element('div', 'mdv-thread-draft-head', 'Draft reply'));
      var text = element('div', 'mdv-thread-draft-body');
      text.innerHTML = markdownHtml(comment.draftReply);
      draft.appendChild(text);
      more.appendChild(draft);
    }

    var controls = controlsHtml(comment, offered, state);
    if (controls) more.appendChild(controls);
    if (more !== thread && more.firstChild) thread.appendChild(more);
    return thread;
  }

  /** Address and Ignore, and the reply being written, under the comment; null for none. */
  function controlsHtml(comment, offered, state) {
    var done = sent[comment.id];
    var mine = responses[comment.id] || done || {};
    var controls = element('div', 'mdv-thread-controls');
    var replying = null;

    for (var i = 0; i < offered.length; i++) {
      var kind = offered[i];
      if (kind === 'address' || kind === 'ignore') {
        // Pressed by the reader's own response only: a comment the program says is addressed wasn't asked for here.
        var pressed = Boolean(mine.response) && state === (kind === 'address' ? 'addressed' : 'ignored');
        var button = element('button', 'mdv-respond mdv-respond-' + kind, kind === 'address' ? 'Address' : 'Ignore');
        button.type = 'button';
        button.dataset.respond = kind;
        button.setAttribute('aria-pressed', String(pressed));
        controls.appendChild(button);
      } else if (kind === 'reply') {
        // A reply already written stays open, with its text.
        if (mine.text != null) replying = mine.text;
      }
    }
    if (replying != null) controls.appendChild(replyBox(replying));
    if (!controls.firstChild) return null;
    // A response sent is what was said: shown as it was, and read-only.
    if (done) {
      var all = controls.querySelectorAll('input, button, textarea');
      for (var k = 0; k < all.length; k++) {
        if (all[k].tagName === 'TEXTAREA') all[k].readOnly = true;
        else all[k].disabled = true;
      }
    }
    return controls;
  }

  function replyBox(text) {
    var area = element('textarea', 'mdv-reply');
    area.rows = 3;
    area.placeholder = 'Reply…';
    area.value = text;
    return area;
  }

  article.addEventListener('change', function (event) {
    var box = event.target.closest('.mdv-respond-done input');
    if (!box) return;
    var comment = findComment(box.closest('.mdv-thread').dataset.comment);
    if (comment) toggle(comment, 'done', 'done', box.checked);
  });

  /**
   * Open the reply box, with the program's draft, which the reader can send
   * as it is: a draft left untouched is still the reply they chose to send.
   */
  function openReply(thread, comment) {
    var area = thread.querySelector('.mdv-reply');
    if (!area) {
      var shown = thread.querySelector('.mdv-thread-draft');
      if (shown) shown.remove();
      var controls = thread.querySelector('.mdv-thread-controls');
      if (!controls) {
        controls = element('div', 'mdv-thread-controls');
        (thread.querySelector('.mdv-thread-more') || thread).appendChild(controls);
      }
      area = replyBox(comment.draftReply || '');
      controls.appendChild(area);
      if (area.value) reply(comment, area.value);
    }
    area.focus();
  }

  article.addEventListener('dblclick', function (event) {
    var body = event.target.closest('.mdv-thread-body');
    var thread = body && body.closest('.mdv-thread');
    var button = thread && thread.querySelector('button.mdv-respond-reply');
    if (!button || button.disabled) return;
    // The double click selected a word, which is not a passage to comment on.
    window.getSelection().removeAllRanges();
    openReply(thread, findComment(thread.dataset.comment));
  });

  article.addEventListener('click', function (event) {
    var button = event.target.closest('button.mdv-respond');
    if (!button) return;
    var thread = button.closest('.mdv-thread');
    var comment = findComment(thread.dataset.comment);
    if (!comment) return;
    var kind = button.dataset.respond;
    if (kind === 'reply') return openReply(thread, comment);
    var on = button.getAttribute('aria-pressed') !== 'true';
    toggle(comment, kind, kind === 'address' ? 'addressed' : 'ignored', on);
  });

  article.addEventListener('input', function (event) {
    var area = event.target.closest('.mdv-reply');
    if (!area) return;
    var comment = findComment(area.closest('.mdv-thread').dataset.comment);
    if (comment) reply(comment, area.value.trim() ? area.value : '');
  });

  function drawThreads() {
    // Every thread, and every holder made for them, goes: a holder is only
    // ever there for threads.
    var old = article.querySelectorAll('.mdv-threads, .mdv-earlier');
    for (var i = 0; i < old.length; i++) old[i].remove();
    var list = annotation.comments || [];
    for (var j = 0; j < list.length; j++) {
      var comment = list[j];
      if (!comment || comment.id == null) continue;
      var place = placeOf(comment);
      place.holder.appendChild(threadHtml(comment, place.displaced));
    }
    drawHistory();
  }

  var HISTORY_KINDS = { accept: 1, 'request-changes': 1, update: 1, comment: 1 };

  /**
   * What happened to the commit (`history`: who did what, and when), as
   * Phabricator's timeline shows a revision's actions: a line each, with no
   * box, among the earlier comments' entries in the order of their dates.
   */
  function drawHistory() {
    var items = Array.isArray(annotation.history) ? annotation.history : [];
    if (!items.length) return;
    var box = timeline();
    for (var i = 0; i < items.length; i++) {
      var item = items[i] || {};
      var kind = HISTORY_KINDS[item.kind] ? item.kind : 'other';
      var line = element('div', 'mdv-history mdv-history-' + kind);
      line.dataset.when = String(item.date || '');
      line.appendChild(element('span', 'mdv-history-icon'));
      line.appendChild(element('span', 'mdv-earlier-who', item.author || 'someone'));
      line.appendChild(element('span', 'mdv-history-did', ' ' + String(item.action || '')));
      if (item.date) {
        var when = element('span', 'mdv-earlier-when', dateText(item.date));
        when.title = String(item.date);
        line.appendChild(when);
      }
      box.appendChild(line);
    }
    // In the order of their dates, a line without one first.
    var all = Array.prototype.slice.call(box.children);
    all.sort(function (a, b) {
      var x = Date.parse(a.dataset.when) || 0;
      var y = Date.parse(b.dataset.when) || 0;
      return x - y;
    });
    for (var k = 0; k < all.length; k++) box.appendChild(all[k]);
  }

  // ---------------------------------------------------------------------------

  function draw() {
    drawStatus();
    drawTitleLinks();
    drawPanels();
    drawActions();
    drawThreads();
  }

  /**
   * What the reader did to the earlier comments since the page loaded, the
   * latest response per comment: `{id, response, text?}`, the response being
   * `done`, `address`, `ignore`, `reply` or `reopen`. A text box still being
   * typed in counts as it stands.
   */
  /**
   * Mark responses as sent, along with the new comments review.js holds,
   * which a call names in the same list.
   */
  var markComments = window.mdvReviewMarkSent;
  window.mdvReviewMarkSent = function (ids) {
    if (markComments) markComments(ids);
    for (var i = 0; i < (ids || []).length; i++) {
      var id = String(ids[i]);
      if (!responses[id]) continue;
      sent[id] = responses[id];
      delete responses[id];
      var comment = findComment(id);
      var thread = threadOf(id);
      if (comment && thread) thread.replaceWith(threadHtml(comment, thread.mdvDisplaced));
    }
    document.dispatchEvent(new CustomEvent('mdv-responses-change', { detail: { count: Object.keys(responses).length } }));
  };

  window.mdvReviewResponses = function () {
    var out = [];
    for (var id in responses) {
      var entry = { id: id, response: responses[id].response };
      if (responses[id].text) entry.text = responses[id].text;
      out.push(entry);
    }
    return out;
  };

  /**
   * Replace this commit's annotation and redraw it. A page holding several
   * commits calls every page's, so one for another commit is turned down.
   * @returns {boolean} whether it was this commit's
   */
  window.mdvSetAnnotations = function (commit, next) {
    if (!isThisCommit(commit)) return false;
    annotation = next || {};
    draw();
    return true;
  };

  draw();
})();
