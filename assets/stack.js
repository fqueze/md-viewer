/**
 * stack-viewer — switching between the commits of a stack, and copying the
 * review of the whole stack out.
 *
 * Each commit's page is the diff page diff-viewer serves, held in an iframe.
 * The pages are same-origin with this one, so this script can reach into a
 * frame: to hear how many comments it has, to forward the keys that switch
 * commits, and to read its comments out when the stack's review is copied.
 */
(function () {
  'use strict';

  var root = document.getElementById('sv-root');
  var pane = document.getElementById('sv-pane');
  var list = document.getElementById('sv-list');
  var review = document.getElementById('sv-review');
  var reviewCount = review.querySelector('.sv-review-count');
  var copyAll = document.getElementById('sv-review-copy');
  var listToggle = document.getElementById('sv-list-toggle');
  var layout = document.getElementById('sv-layout');
  var entries = list.querySelectorAll('.sv-entry');
  var fileLists = list.querySelectorAll('.sv-files-of');
  var commits = list.querySelector('.sv-commits');
  var splitter = document.getElementById('sv-splitter');
  var widthHandle = document.getElementById('sv-width-handle');
  var files = document.getElementById('sv-files');

  /** @type {{sha: string, label: string, subject: string}[]} */
  var meta = JSON.parse(document.getElementById('sv-meta').textContent);
  /** The frame for each commit, once the reader has opened it. */
  var frames = new Array(meta.length);
  /** Comments on each commit so far, as its frame last reported them. */
  var counts = new Array(meta.length);
  var current = -1;
  /** Side by side or not, once the reader has said; until then each page guesses. */
  var chosenSplit = null;

  // ---------------------------------------------------------------------------
  // Frames
  // ---------------------------------------------------------------------------

  /**
   * The frame for commit `i`, made on first use. Its document is set before
   * the frame joins the page: a frame that is navigated after it is in the
   * page adds an entry to the tab's history, and the back button would then
   * step through commits opened rather than pages visited.
   */
  function frameFor(i) {
    if (frames[i]) return frames[i];
    var frame = document.createElement('iframe');
    frame.className = 'sv-frame';
    frame.title = meta[i].subject || meta[i].label;
    frame.srcdoc = JSON.parse(document.getElementById('sv-page-' + i).textContent);
    frame.addEventListener('load', function () {
      attach(frame, i);
    });
    pane.appendChild(frame);
    frames[i] = frame;
    return frame;
  }

  /** Listen to a frame's page once it has loaded. */
  function attach(frame, i) {
    var win = frame.contentWindow;
    var doc = frame.contentDocument;
    if (!win || !doc) return;
    doc.addEventListener('mdv-review-change', function (event) {
      setCount(i, event.detail.count);
    });
    win.addEventListener('keydown', onKeyDown);
    track(win, doc, i);
    applyLayout(i);
    // A page picks its layout from its width until the reader picks one, and
    // the switch up here shows what the current page picked.
    win.addEventListener('resize', function () {
      if (i === current) syncLayout();
    });
    if (i === current) win.focus();
  }

  /**
   * Keep the file at the top of a commit's page marked in that commit's list,
   * as Phabricator does, so the list also says where in the commit the reader
   * is. That is the first file whose section has not yet scrolled out of view
   * above. The work waits for the next frame, since scrolling fires faster
   * than anything is drawn.
   */
  function track(win, doc, i) {
    // The commit message is drawn as a section too, ahead of the files.
    var sections = doc.querySelectorAll('.dv-file:not(.dv-message)');
    var buttons = fileLists[i].querySelectorAll('.sv-file');
    var shown = -1;
    var pending = false;

    function update() {
      pending = false;
      var n = 0;
      while (n < sections.length - 1 && sections[n].getBoundingClientRect().bottom <= 0) n++;
      if (n === shown) return;
      shown = n;
      for (var k = 0; k < buttons.length; k++) {
        var here = Number(buttons[k].dataset.file) === n;
        buttons[k].classList.toggle('sv-file-current', here);
        if (here) keepInView(buttons[k]);
      }
    }
    function schedule() {
      if (pending) return;
      pending = true;
      win.requestAnimationFrame(update);
    }
    win.addEventListener('scroll', schedule);
    // Switching between one column and two changes how tall every section is.
    win.addEventListener('resize', schedule);
    update();
  }

  /** Scroll the list of files, and only it, so that `button` is in sight. */
  function keepInView(button) {
    var top = button.offsetTop;
    var bottom = top + button.offsetHeight;
    if (top < files.scrollTop) {
      files.scrollTop = top;
    } else if (bottom > files.scrollTop + files.clientHeight) {
      files.scrollTop = bottom - files.clientHeight;
    }
  }

  function show(i) {
    if (i < 0 || i >= meta.length || i === current) return;
    var frame = frameFor(i);
    for (var j = 0; j < frames.length; j++) {
      if (frames[j]) frames[j].classList.toggle('sv-frame-current', j === i);
    }
    for (j = 0; j < entries.length; j++) {
      if (j === i) {
        entries[j].setAttribute('aria-current', 'true');
      } else {
        entries[j].removeAttribute('aria-current');
      }
    }
    for (j = 0; j < fileLists.length; j++) {
      fileLists[j].hidden = j !== i;
    }
    current = i;
    syncLayout();
    if (entries[i].scrollIntoView) entries[i].scrollIntoView({ block: 'nearest' });
    document.title = (meta[i].subject || meta[i].label) + ' — ' + root.dataset.title;
    // The hash is where the reader is, so a reload comes back to the same
    // commit. Replaced rather than pushed: the back button should leave the
    // page, not retrace a review.
    history.replaceState(null, '', '#' + (i + 1));
    // The keys that switch commits are read from the frame, so it should
    // hold the focus. A frame still loading takes it when it arrives.
    if (frame.contentWindow && frame.contentDocument && frame.contentDocument.readyState === 'complete') {
      frame.contentWindow.focus();
    }
  }

  /** Scroll the current commit's page to its `n`th file. */
  function reveal(n) {
    var frame = frames[current];
    // A frame that has not loaded yet has no sections to scroll to.
    var section = frame.contentDocument && frame.contentDocument.getElementById('dv-file-' + n);
    if (!section) return;
    section.scrollIntoView({ block: 'start' });
    // Back to the page, so that the keys it listens for still reach it.
    frame.contentWindow.focus();
  }

  // ---------------------------------------------------------------------------
  // Layout
  // ---------------------------------------------------------------------------

  /**
   * The layout switch of commit `i`'s page. Each page keeps its own, hidden,
   * and the one in this page's bar drives them through it, so a page lays
   * itself out exactly as it does when its own switch is flipped. A page that
   * has not loaded yet has none.
   */
  function pageSwitch(i) {
    var doc = frames[i] && frames[i].contentDocument;
    return doc && doc.getElementById('dv-layout');
  }

  function syncLayout() {
    var own = pageSwitch(current);
    if (own) layout.checked = own.checked;
  }

  function applyLayout(i) {
    var own = pageSwitch(i);
    if (!own || chosenSplit === null) return;
    own.checked = chosenSplit;
    own.dispatchEvent(new Event('change'));
  }

  layout.addEventListener('change', function () {
    chosenSplit = layout.checked;
    for (var i = 0; i < frames.length; i++) applyLayout(i);
  });

  function fromHash() {
    var n = parseInt(location.hash.slice(1), 10);
    return n >= 1 && n <= meta.length ? n - 1 : 0;
  }

  // ---------------------------------------------------------------------------
  // Comments
  // ---------------------------------------------------------------------------

  function setCount(i, count) {
    counts[i] = count;
    var badge = entries[i].querySelector('.sv-entry-comments');
    badge.hidden = !count;
    badge.textContent = count;

    var total = 0;
    var commits = 0;
    for (var j = 0; j < counts.length; j++) {
      if (counts[j]) {
        total += counts[j];
        commits++;
      }
    }
    review.hidden = total === 0;
    reviewCount.textContent =
      total +
      (total === 1 ? ' comment' : ' comments') +
      ' on ' +
      commits +
      (commits === 1 ? ' commit' : ' commits');
  }

  /**
   * The review of the whole stack: one preamble, then each commit that has
   * comments under a heading naming it, in the stack's order. Each commit's
   * entries are written by its own page, so a comment reads the same here as
   * it does copied out of that page alone.
   */
  function prompt() {
    var out = ['Please address these review comments on the following commits:', ''];
    for (var i = 0; i < frames.length; i++) {
      var frame = frames[i];
      var win = frame && frame.contentWindow;
      if (!win || !win.mdvReviewComments || !win.mdvReviewEntries) continue;
      var comments = win.mdvReviewComments();
      if (!comments.length) continue;
      var heading = 'commit ' + meta[i].sha;
      if (meta[i].subject) heading += ' (' + meta[i].subject + ')';
      out.push('## ' + heading, '', win.mdvReviewEntries(comments).replace(/\s+$/, ''), '');
    }
    return out.join('\n');
  }

  function flash(button, message) {
    var original = button.textContent;
    button.textContent = message;
    button.disabled = true;
    setTimeout(function () {
      button.textContent = original;
      button.disabled = false;
    }, 1200);
  }

  copyAll.addEventListener('click', function () {
    var text = prompt();
    navigator.clipboard.writeText(text).then(
      function () {
        flash(copyAll, 'Copied');
      },
      function () {
        flash(copyAll, 'Copy failed');
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Keys and clicks
  // ---------------------------------------------------------------------------

  /**
   * Alt+Up and Alt+Down step through the stack, and so do Shift+Up and
   * Shift+Down, which leave the bare arrows to scroll the diff; Alt+L hides
   * the list. Modifiers rather than bare letters, because a commit's page
   * turns the first letter typed after a selection into the start of a
   * comment; and not while a text field has the focus, where these move and
   * extend the caret.
   */
  function onKeyDown(event) {
    if (event.altKey === event.shiftKey || event.metaKey || event.ctrlKey) return;
    var target = event.target;
    if (target && target.closest && target.closest('textarea, input, [contenteditable]')) return;
    if (event.key === 'ArrowDown') {
      show(current + 1);
    } else if (event.key === 'ArrowUp') {
      show(current - 1);
    } else if (event.altKey && (event.key === 'l' || event.key === 'L' || event.code === 'KeyL')) {
      toggleList();
    } else {
      return;
    }
    event.preventDefault();
  }

  // ---------------------------------------------------------------------------
  // The splitters: between the commits and the files, and beside the list
  // ---------------------------------------------------------------------------

  /**
   * Call `move` with each pointer event of a drag begun on `handle`. The
   * pointer is captured, so the drag keeps going when it crosses into a
   * commit's frame, which would otherwise take the events for itself.
   */
  function draggable(handle, move) {
    handle.addEventListener('pointerdown', function (event) {
      if (event.button !== 0) return;
      event.preventDefault();
      handle.setPointerCapture(event.pointerId);
      function end() {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', end);
        handle.removeEventListener('pointercancel', end);
      }
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', end);
      handle.addEventListener('pointercancel', end);
    });
  }

  // The height of the commits; the files take the rest.
  draggable(splitter, function (event) {
    var room = list.clientHeight - splitter.offsetHeight;
    var height = Math.max(0, Math.min(event.clientY - commits.getBoundingClientRect().top, room));
    commits.style.flex = '0 0 ' + height + 'px';
    commits.style.maxHeight = 'none';
  });

  // The width of the list; the commit's page takes the rest, and keeps at
  // least a third of the window.
  draggable(widthHandle, function (event) {
    var width = event.clientX - list.getBoundingClientRect().left;
    width = Math.max(120, Math.min(width, (window.innerWidth * 2) / 3));
    root.style.setProperty('--sv-list-width', width + 'px');
  });

  // A double-click on either puts it back where it started.
  splitter.addEventListener('dblclick', function () {
    commits.style.flex = '';
    commits.style.maxHeight = '';
  });
  widthHandle.addEventListener('dblclick', function () {
    root.style.removeProperty('--sv-list-width');
  });

  function toggleList() {
    root.classList.toggle('sv-list-hidden');
  }

  list.addEventListener('click', function (event) {
    var entry = event.target.closest('.sv-entry');
    if (entry) show(Number(entry.dataset.index));
    var file = event.target.closest('.sv-file');
    if (file) reveal(Number(file.dataset.file));
  });
  listToggle.addEventListener('click', toggleList);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('hashchange', function () {
    show(fromHash());
  });

  show(fromHash());
})();
