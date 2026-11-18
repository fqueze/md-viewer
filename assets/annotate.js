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
    var a = event.target.closest && event.target.closest('a.mdv-title-link');
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

  function draw() {
    drawStatus();
    drawTitleLinks();
    drawActions();
  }

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
