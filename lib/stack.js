/**
 * Reading a stack of commits out of a repository, for stack-viewer.
 *
 * A stack is named the way its tool names it: a jj revset such as `lqs::tvz`,
 * or in a plain git checkout a range such as `main..HEAD`. Either way what
 * comes back is the commits in the order they build on each other, oldest
 * first, which is the order a stack is reviewed in.
 *
 * The patches themselves are read with git, whichever tool named them. jj
 * keeps every commit in a git object store, the snapshotted working copy
 * included, and `git show` writes the exact form the diff renderer already
 * reads — the `commit <sha>` header, the indented message, the files — so a
 * commit in a stack renders as the same page a commit link in a document
 * does. `jj show --git` would draw the same diff under a different header
 * (`Commit ID:`, `Change ID:`, ...), which would need a second parser for
 * the message and gain nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { MAX_PATCH_BYTES, runGit, showArgs } from './git.js';
import { diffFiles } from './diff.js';

/** How many `git show` processes to run at once. A stack of thirty commits
 *  in a large repository should not be thirty git processes at once, and one
 *  at a time leaves the other cores idle. */
const SHOW_CONCURRENCY = 4;

/** The tip of the stack `@` is in: `@` itself when it is the top of it, and
 *  otherwise the newest of the heads growing out of it, so that editing a
 *  commit in the middle of a stack still shows the whole stack. `latest`
 *  picks one when the edited commit has been branched off more than once —
 *  a stack is a line, and the other branches are other stacks. */
const JJ_STACK_TIP = 'latest(heads(descendants(@)))';

/** The stack that is applied right now, for when no revset is given.
 *
 *  `trunk()` is jj's own name for the branch the work is going onto, which a
 *  repository that does not call it `main` has already had to configure, and
 *  which falls back to main/master/trunk on origin or upstream.
 *
 *  The tip is dropped when it is the empty undescribed commit `jj new` leaves
 *  on top of a stack to work in: it is not a patch anyone wrote, and a page
 *  for it would be blank. An empty commit that has a description is somebody's
 *  placeholder, and is left in. */
const JJ_DEFAULT_REVSET =
  `trunk()..${JJ_STACK_TIP} ~ (${JJ_STACK_TIP} & empty() & description(exact:""))`;

/** Where a plain git checkout's stack starts, most specific first: the
 *  branch the remote calls its default, then the usual names for it. Not the
 *  upstream of the current branch — once a feature branch has been pushed
 *  that is its own copy on the remote, and the stack would be only what has
 *  not been pushed yet. */
const GIT_DEFAULT_BASES = [
  'origin/HEAD',
  'origin/main',
  'origin/master',
  'main',
  'master',
];

/**
 * How many commits a stack can name before the viewer refuses to build it.
 *
 * Every commit becomes a whole review page carried inside the one document, so
 * a stack is paid for in this process's memory while it is built and in the
 * tab's for as long as it is open. A hundred is already a page nobody reads to
 * the end of, and well past any stack written to be reviewed.
 *
 * What the limit is really for is the range that was not meant: `main..HEAD`
 * where `main` was last pulled months ago names every commit since, which is
 * thousands in a large repository. That is a mistake to report in the moment
 * it is made, not to spend a minute and several gigabytes discovering.
 */
export const MAX_STACK_COMMITS = 100;

/**
 * How many bytes of patch a stack can hold, whatever its commit count.
 *
 * The count is what a reader controls and so what the error talks about, but
 * it is the bytes that exhaust the heap: building a page copies its patch into
 * rendered HTML and again into the JSON the outer document carries it in. Ten
 * commits that each rewrite a vendored tree will do it. A stack this large has
 * no chance of rendering in a browser either, so there is nothing lost in
 * stopping while the error can still be printed.
 */
export const MAX_STACK_BYTES = 64 * 1024 * 1024;

/**
 * The largest file whose new version the page carries, to show more of it
 * than the patch does. Past this a file is generated, vendored or data, and
 * nobody reads it for its context — while the page would carry all of it.
 */
export const MAX_CONTEXT_FILE_BYTES = 1024 * 1024;

/**
 * The repository containing `dir`, found by walking up, and which tool owns it.
 *
 * `.jj` is looked for first at each level: a colocated jj repository has both
 * a `.jj` and a `.git`, and it is jj's revsets the reader will be writing.
 * @returns {{root: string, kind: 'jj'|'git'}|null}
 */
export function findStackRepository(dir) {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, '.jj'))) {
      return { root: at, kind: 'jj' };
    }
    if (fs.existsSync(path.join(at, '.git'))) {
      return { root: at, kind: 'git' };
    }
    const parent = path.dirname(at);
    if (parent === at) {
      return null;
    }
    at = parent;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { maxBuffer: 16 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' }, ...options },
      (error, stdout, stderr) => {
        if (error) {
          // jj's own messages start with `Error: `, which the caller adds too.
          reject(new Error(stderr.trim().replace(/^Error: /, '') || error.message));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Open the repository at `root` for reading a stack out of.
 *
 * Resolves the git directory up front — `jj git root` for a jj repository,
 * which is `.git` when colocated and inside `.jj` when not, and `rev-parse`
 * for git, which follows a worktree's `.git` file to the real one.
 *
 * @returns {Promise<{
 *   root: string, kind: 'jj'|'git', gitDir: string,
 *   defaultStack(): Promise<{revset: string, title: string, base: string}>,
 *   list(revset: string): Promise<{sha: string, label: string}[]>,
 *   show(sha: string): Promise<string>,
 * }>}
 */
export async function openStack({ root, kind }) {
  const gitDir =
    kind === 'jj'
      ? (await run('jj', ['-R', root, '--ignore-working-copy', 'git', 'root'])).trim()
      : (await runGit(['-C', root, 'rev-parse', '--absolute-git-dir'])).trim();

  return {
    root,
    kind,
    gitDir,

    /**
     * The stack that is applied right now, named the way this tool names it:
     * the `revset` to list, a short `title` to show for it — the revset that
     * finds a jj stack is too long to read at the top of a page — and the
     * `base` it grows from, to say so when nothing is on top of it.
     */
    async defaultStack() {
      if (kind === 'jj') {
        return { revset: JJ_DEFAULT_REVSET, title: 'current stack', base: 'trunk()' };
      }
      for (const candidate of GIT_DEFAULT_BASES) {
        // `--abbrev-ref` says which branch the symbolic one means, which is
        // what to show the reader: `origin/main..HEAD`, not `origin/HEAD..HEAD`.
        // It fails when the ref does not exist, which is how the list is
        // walked.
        let base;
        try {
          const args = ['--abbrev-ref', '--verify', '--quiet', candidate];
          base = (await runGit(['-C', root, 'rev-parse', ...args])).trim();
        } catch {
          continue;
        }
        return { revset: `${base}..HEAD`, title: `${base}..HEAD`, base };
      }
      throw new Error(
        'cannot tell where this stack starts — no origin/main and no main; name a range',
      );
    },

    /**
     * The commits `revset` names, oldest first, each with the label the reader
     * knows it by: jj's change id, which survives the commit being rewritten,
     * or for git a short sha.
     *
     * `jj log` snapshots the working copy before answering, which is wanted: a
     * stack that ends at `@` should show what is on disk now, as `jj diff`
     * would. The one-line template keeps the parsing to a split.
     */
    async list(revset) {
      if (kind === 'jj') {
        const out = await run('jj', [
          '-R',
          root,
          'log',
          '-r',
          revset,
          '--no-graph',
          '--reversed',
          '--color=never',
          '-T',
          'commit_id ++ " " ++ change_id.short(8) ++ "\\n"',
        ]);
        return parseListing(out);
      }
      // `rev-list` on a single commit walks its whole history, which nobody
      // reviewing a stack means; a range is the only spelling that walks.
      const walk = /\.\./.test(revset) ? ['--topo-order', '--reverse'] : ['--no-walk'];
      // A bare sha per line, which parseListing labels with a short prefix.
      return parseListing(await runGit(['-C', root, 'rev-list', ...walk, revset, '--']));
    },

    /**
     * What `git cat-file --batch-check` says of each object name — a blob
     * named `<commit>:<path>`, typically: `{oid, type, size}`, or nothing
     * for a name that names nothing, such as a path the commit does not have.
     * @returns {Promise<Map<string, {oid: string, type: string, size: number}>>}
     */
    async check(names) {
      const out = new Map();
      if (!names.length) return out;
      const lines = (await catFile(gitDir, '--batch-check', names)).toString('utf8').split('\n');
      names.forEach((name, i) => {
        const [oid, type, size] = (lines[i] || '').split(' ');
        if (type && type !== 'missing' && size) out.set(name, { oid, type, size: Number(size) });
      });
      return out;
    },

    /**
     * The contents of blobs, by id, read in one `git cat-file --batch`.
     * @returns {Promise<Map<string, Buffer>>}
     */
    async blobs(oids) {
      const out = new Map();
      if (!oids.length) return out;
      const data = await catFile(gitDir, '--batch', oids);
      // Each is a header line, `<oid> <type> <size>`, its bytes, and a newline.
      let at = 0;
      while (at < data.length) {
        const end = data.indexOf(10, at);
        if (end === -1) break;
        const [oid, type, size] = data.toString('utf8', at, end).split(' ');
        if (type === 'missing' || !size) {
          at = end + 1;
          continue;
        }
        const start = end + 1;
        out.set(oid, data.subarray(start, start + Number(size)));
        at = start + Number(size) + 1;
      }
      return out;
    },

    /** One commit as `git show` writes it, message and patch together. */
    show(sha) {
      return runGit(['--git-dir', gitDir, ...showArgs(sha)], { maxBuffer: MAX_PATCH_BYTES });
    },

    /**
     * What `ref` tracks -- `origin/main` for `main` -- or null if it tracks
     * nothing, or if this is a jj repository, where a revset has no base to
     * be stale.
     *
     * Asked only to make a better error: a range that came back far longer
     * than anyone meant is nearly always one whose base has not been pulled,
     * and the branch git already knows it tracks is the fix to suggest.
     */
    async upstreamOf(ref) {
      if (kind === 'jj') {
        return null;
      }
      try {
        const out = await runGit([
          '-C',
          root,
          'rev-parse',
          '--abbrev-ref',
          '--symbolic-full-name',
          `${ref}@{upstream}`,
        ]);
        return out.trim() || null;
      } catch {
        return null;
      }
    },
  };
}

/** Run `git cat-file` with these object names on its input; its output. */
function catFile(gitDir, mode, names) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['--git-dir', gitDir, 'cat-file', mode], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    const chunks = [];
    let stderr = '';
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) =>
      code ? reject(new Error(stderr.trim() || `git cat-file exited with ${code}`)) : resolve(Buffer.concat(chunks)),
    );
    child.stdin.on('error', () => {});
    child.stdin.end(names.join('\n') + '\n');
  });
}

/** Whether a file's bytes are text: git's own test, a NUL near the start. */
function isText(bytes) {
  return !bytes.subarray(0, 8000).includes(0);
}

/**
 * Each changed file's new version, for every commit of a stack, which the
 * page shows more of the file from. Read in two passes over the whole stack —
 * what each name is and how large, then the contents of those worth carrying
 * — so a stack costs two git processes, and a blob several commits share is
 * read once.
 *
 * None for a deleted file, nor for one larger than MAX_CONTEXT_FILE_BYTES or
 * that is binary.
 *
 * @returns {Promise<Array<Record<string, {newOid: string, newText: string}>>>}
 *   per patch, by the renderer's path
 */
export async function readFileVersions(stack, patches) {
  const wanted = patches.map((patch) =>
    diffFiles(patch.source).map((file) => ({
      path: file.path,
      newName: file.to && `${patch.sha}:${file.to}`,
    })),
  );
  const names = [...new Set(wanted.flat().map((file) => file.newName).filter(Boolean))];
  const found = await stack.check(names);
  const blob = (name, limit) => {
    const object = name && found.get(name);
    return object && object.type === 'blob' && object.size <= limit ? object.oid : null;
  };
  const oids = new Set();
  for (const file of wanted.flat()) {
    file.newOid = blob(file.newName, MAX_CONTEXT_FILE_BYTES);
    if (file.newOid) oids.add(file.newOid);
  }
  const contents = await stack.blobs([...oids]);
  const texts = new Map();
  for (const [oid, bytes] of contents) {
    if (isText(bytes)) texts.set(oid, bytes.toString('utf8'));
  }

  return wanted.map((files) => {
    const versions = {};
    for (const file of files) {
      if (texts.has(file.newOid)) versions[file.path] = { newOid: file.newOid, newText: texts.get(file.newOid) };
    }
    return versions;
  });
}

/** `<sha> <label>` per line, or a bare sha, which labels itself by prefix. */
function parseListing(out) {
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha, label] = line.split(/\s+/);
      return { sha, label: label || sha.slice(0, 12) };
    });
}

/**
 * Read every commit of a stack, a few at a time, keeping the stack's order.
 * @returns {Promise<{sha: string, label: string, source: string}[]>}
 */
export async function readStack(stack, commits, { maxBytes = MAX_STACK_BYTES } = {}) {
  const out = new Array(commits.length);
  let next = 0;
  let read = 0;
  const worker = async () => {
    while (next < commits.length) {
      const i = next++;
      const source = await stack.show(commits[i].sha);
      read += source.length;
      if (read > maxBytes) {
        throw new Error(
          `the patches pass ${Math.round(maxBytes / (1024 * 1024))} MB, ` +
            'which is more than one page can carry',
        );
      }
      out[i] = { ...commits[i], source };
    }
  };
  await Promise.all(Array.from({ length: Math.min(SHOW_CONCURRENCY, commits.length) }, worker));
  return out;
}
