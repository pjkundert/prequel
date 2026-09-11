// Thin wrapper over the `git` CLI. All diffing is delegated to git so the
// output matches real PR semantics (rename detection, binary detection, etc.).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

// Run git in a repo. `okCodes` lists non-zero exit codes to treat as success
// (git diff --no-index returns 1 when files differ, which is not an error).
function git(repoRoot, args, { okCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      // core.quotePath=false keeps non-ASCII paths literal instead of octal-escaped.
      ['-c', 'core.quotePath=false', '-C', repoRoot, ...args],
      { maxBuffer: 256 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !okCodes.includes(err.code)) {
          reject(new Error(`git ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

export async function resolveRepoRoot(cwd) {
  try {
    const out = await git(cwd, ['rev-parse', '--show-toplevel']);
    return out.trim() || null;
  } catch {
    return null;
  }
}

// Pick a sensible base ref: prefer main, then master, then origin's default.
export async function getDefaultBase(repoRoot) {
  const candidates = ['main', 'master'];
  for (const ref of candidates) {
    try {
      await git(repoRoot, ['rev-parse', '--verify', '--quiet', ref]);
      return ref;
    } catch {
      /* not present */
    }
  }
  try {
    const out = await git(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
    const ref = out.trim();
    if (ref) return ref; // e.g. "origin/main"
  } catch {
    /* no origin HEAD */
  }
  return 'HEAD'; // last resort: diff against working tree only
}

// Current branch name, or a short SHA when detached.
export async function getHead(repoRoot) {
  const name = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (name && name !== 'HEAD') return name;
  const sha = (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
  return sha || 'HEAD';
}

// A user-supplied ref, validated: it must name a commit and cannot look like
// an option. Returns the ref as given, or null.
export async function resolveRef(repoRoot, ref) {
  if (!ref || typeof ref !== 'string' || ref.startsWith('-')) return null;
  try {
    await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    return ref;
  } catch {
    return null;
  }
}

// Local branches, most recently committed first.
export async function getBranches(repoRoot) {
  const out = await git(repoRoot, [
    'for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads',
  ]).catch(() => '');
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

// A branch's recorded review base (`git config branch.<name>.reviewbase`),
// so a review opens on exactly the change it was staged for.
export async function getReviewBase(repoRoot, ref) {
  if (!ref || ref.startsWith('-')) return null;
  const out = await git(repoRoot, ['config', '--get', `branch.${ref}.reviewbase`], {
    okCodes: [0, 1],
  }).catch(() => '');
  if (out.trim()) return out.trim();
  // Config does not travel with a push; a tag <ref>-baseline on the same
  // commit does, so another clone finds the review base too.
  const tag = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/tags/${ref}-baseline`], {
    okCodes: [0, 1],
  }).catch(() => '');
  return tag.trim() ? `${ref}-baseline` : null;
}

// The repository's common git dir (shared by all its worktrees), absolute:
// what a client in any worktree can match this server against.
export async function getGitCommonDir(repoRoot) {
  const out = (await git(repoRoot, ['rev-parse', '--git-common-dir']).catch(() => '')).trim();
  return out ? path.resolve(repoRoot, out) : null;
}

async function mergeBase(repoRoot, base, ref = 'HEAD') {
  try {
    return (await git(repoRoot, ['merge-base', base, ref])).trim();
  } catch {
    return base; // base may not share history (e.g. HEAD sentinel) — diff directly
  }
}

const DIFF_FLAGS = ['--no-color', '--find-renames', '--find-copies'];

async function untrackedPatches(repoRoot) {
  const listing = await git(repoRoot, ['ls-files', '--others', '--exclude-standard']);
  const files = listing.split('\n').map((s) => s.trim()).filter(Boolean);
  const patches = [];
  for (const file of files) {
    // --no-index synthesizes an "added file" patch; exit code 1 == differs.
    const patch = await git(
      repoRoot,
      ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', file],
      { okCodes: [0, 1] }
    );
    if (patch) patches.push(patch);
  }
  return patches.join('');
}

/**
 * Produce the raw combined patch text for the requested mode.
 *  - branch:  committed changes on this branch vs base (closest to a real PR)
 *  - working: uncommitted changes (staged + unstaged) + untracked
 *  - all:     branch commits + working tree + untracked (default; superset)
 */
// `ref`, when given, is a branch other than the checked-out one: its committed
// changes are diffed straight from git (mode is then always 'branch'); the
// working tree belongs to HEAD alone.
export async function getDiff(repoRoot, { base, mode = 'all', ref = null } = {}) {
  const head = ref || (await getHead(repoRoot));
  const target = ref || 'HEAD';
  const baseRef = base || (await getDefaultBase(repoRoot));

  let patch = '';
  if (mode === 'working') {
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, 'HEAD']);
    patch += await untrackedPatches(repoRoot);
  } else if (mode === 'branch') {
    const mb = await mergeBase(repoRoot, baseRef, target);
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, mb, target]);
  } else {
    // all
    const mb = await mergeBase(repoRoot, baseRef);
    patch = await git(repoRoot, ['diff', ...DIFF_FLAGS, mb]);
    patch += await untrackedPatches(repoRoot);
  }

  return { patch, head, base: baseRef, mode };
}

// Fetch a contiguous range of lines from a file for hunk-context expansion.
// rev === 'WORKTREE' reads the on-disk file (matches what's shown for
// all/working modes, including uncommitted edits); otherwise `git show rev:path`.
// start/end are 1-based inclusive. `eof` is true when `end` reached past the
// last line, so the caller can stop offering further downward expansion.
export async function getBlobLines(repoRoot, { rev, path: filePath, start, end }) {
  let content;
  if (rev === 'WORKTREE') {
    const abs = path.join(repoRoot, filePath);
    // guard against path traversal escaping the repo
    if (!abs.startsWith(path.resolve(repoRoot) + path.sep)) return { lines: [], eof: true };
    content = await fs.readFile(abs, 'utf8').catch(() => '');
  } else {
    // --textconv: the same conversion 'git diff' applied to the hunks (a
    // textconv driver from .gitattributes, when there is one), so expanded
    // context lines up with them; without a driver it is the plain blob.
    content = await git(repoRoot, ['cat-file', '--textconv', `${rev}:${filePath}`]).catch(() => '');
  }
  const all = content.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop(); // drop trailing newline artifact
  const from = Math.max(1, start);
  const lines = all.slice(from - 1, end);
  return { lines, from, eof: end >= all.length };
}
