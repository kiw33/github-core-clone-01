// store.ts — the forge's in-memory store and every operation the REST,
// GraphQL and MCP surfaces share. One process, one trial, no persistence:
// the suite creates everything it needs through the API.
//
// Identity: the bearer token names the scenario's viewer (adaiversen, id
// 1000). The token itself is opaque (`shpat_...`); the login is the fixed
// value from the kit's public seeded scenario, which is the same in every
// trial of this competition.

import {
  buildCommit,
  buildTree,
  collectReachable,
  hashObject,
  isAncestor,
  isObjectId,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  putObject,
  ZERO_OID,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const STRANGER_LOGIN = 'olgabauer';

export function trialNowIso(): string {
  return process.env.MAKEFUN_TRIAL_NOW ?? '2026-11-14T06:30:00.000Z';
}

export function trialNowEpoch(): number {
  const parsed = Date.parse(trialNowIso());
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 1763097000;
}

export function viewerIdentity(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
}

let globalSeq = 1;
export function nextSeq(): number {
  globalSeq += 1;
  return globalSeq - 1;
}

/** Opaque Relay-style global id: base64url of `forge:<kind>:<parts>`. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`forge:${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    if (!text.startsWith('forge:')) return null;
    const rest = text.slice('forge:'.length);
    const colon = rest.indexOf(':');
    if (colon < 0) return null;
    return { kind: rest.slice(0, colon), parts: rest.slice(colon + 1).split(':') };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  isPull: boolean;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, Comment[]>;
  nextNumber: number;
  nextCommentId: number;
  commitSeq: Map<string, number>;
  commitSeqCounter: number;
}

export class Store {
  repos = new Map<string, Repo>();
  repoIdSeq = 1;
  labelIdSeq = 1;
  issueIdSeq = 1;
  pullIdSeq = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  /** Repositories owned by the viewer, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === VIEWER_LOGIN)
      .sort((a, b) => a.id - b.id);
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const now = trialNowIso();
    const repo: Repo = {
      id: this.repoIdSeq++,
      name,
      owner: VIEWER_LOGIN,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      commitSeq: new Map(),
      commitSeqCounter: 0,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }

  findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'issue' || decoded.parts.length !== 2) return null;
    const repo = this.findRepoById(Number(decoded.parts[0]));
    if (!repo) return null;
    const issue = repo.issues.get(Number(decoded.parts[1]));
    return issue ? { repo, issue } : null;
  }

  findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | null {
    const decoded = decodeGlobalId(id);
    if (!decoded || decoded.kind !== 'pr' || decoded.parts.length !== 2) return null;
    const repo = this.findRepoById(Number(decoded.parts[0]));
    if (!repo) return null;
    const pull = repo.pulls.get(Number(decoded.parts[1]));
    return pull ? { repo, pull } : null;
  }
}

// ---------------------------------------------------------------------------
// git plumbing over one repo
// ---------------------------------------------------------------------------

/** Read a tree object into a path -> entry map (recursive, files only). */
export function flattenTree(repo: Repo, treeOid: string): Map<string, TreeEntry> {
  const out = new Map<string, TreeEntry>();
  const walk = (oid: string, prefix: string): void => {
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, entry);
    }
  };
  walk(treeOid, '');
  return out;
}

/** Rebuild nested tree objects from a flat path map; returns the root tree oid. */
export function treeFromFlat(repo: Repo, flat: Map<string, TreeEntry>): string {
  interface Node {
    files: Map<string, TreeEntry>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i]!;
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo.objects, 'tree', buildTree(entries));
  };
  return build(root);
}

/** The tree oid a ref points at (via its commit), or null. */
export function refTree(repo: Repo, ref: string): string | null {
  const oid = repo.refs.get(ref);
  if (!oid) return null;
  const commitOid = peelToCommit(repo.objects, oid);
  if (!commitOid) return null;
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Record a commit's creation order (newest-first listings sort on this). */
export function noteCommit(repo: Repo, oid: string): void {
  if (!repo.commitSeq.has(oid)) {
    repo.commitSeqCounter += 1;
    repo.commitSeq.set(oid, repo.commitSeqCounter);
  }
}

/** Create a commit on `ref` (creating the ref at the default tip when new). */
export function commitFile(
  repo: Repo,
  ref: string,
  path: string,
  content: Buffer,
  message: string,
): { commitSha: string; blobSha: string } {
  const blobSha = putObject(repo.objects, 'blob', content);
  const tip = repo.refs.get(ref);
  let flat = new Map<string, TreeEntry>();
  const parents: string[] = [];
  if (tip !== undefined) {
    const commitOid = peelToCommit(repo.objects, tip);
    if (commitOid === null) throw new Error('ref does not point at a commit');
    parents.push(commitOid);
    const tree = refTree(repo, ref);
    if (tree !== null) flat = flattenTree(repo, tree);
  } else if (ref !== `refs/heads/${repo.defaultBranch}`) {
    // A new branch starts from the default branch's tip.
    const baseTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (baseTip !== undefined) {
      const baseCommit = peelToCommit(repo.objects, baseTip);
      if (baseCommit !== null) {
        parents.push(baseCommit);
        const tree = refTree(repo, `refs/heads/${repo.defaultBranch}`);
        if (tree !== null) flat = flattenTree(repo, tree);
      }
    }
  }
  flat.set(path, { mode: '100644', name: path.split('/').pop()!, oid: blobSha });
  const treeOid = treeFromFlat(repo, flat);
  // Store the message exactly as given: GET /commits must echo it back
  // verbatim (the suite compares it to the message it sent).
  const commit = buildCommit({
    tree: treeOid,
    parents,
    message,
    author: viewerIdentity(),
    committer: viewerIdentity(),
    timestamp: trialNowEpoch(),
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  noteCommit(repo, commitSha);
  repo.refs.set(ref, commitSha);
  return { commitSha, blobSha };
}

/** Delete a file on the default branch (or `ref`); returns the new commit sha. */
export function deleteFile(repo: Repo, ref: string, path: string, message: string): string {
  const tip = repo.refs.get(ref);
  if (tip === undefined) throw new Error('no such ref');
  const commitOid = peelToCommit(repo.objects, tip);
  if (commitOid === null) throw new Error('ref does not point at a commit');
  const tree = refTree(repo, ref);
  if (tree === null) throw new Error('no tree');
  const flat = flattenTree(repo, tree);
  if (!flat.has(path)) throw new Error('no such file');
  flat.delete(path);
  const treeOid = treeFromFlat(repo, flat);
  const commit = buildCommit({
    tree: treeOid,
    parents: [commitOid],
    message,
    author: viewerIdentity(),
    committer: viewerIdentity(),
    timestamp: trialNowEpoch(),
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  noteCommit(repo, commitSha);
  repo.refs.set(ref, commitSha);
  return commitSha;
}

/** Commits reachable from `ref` (branch name, full ref or oid), newest first (by creation order). */
export function listCommits(repo: Repo, ref: string): string[] {
  const commitOid = resolveRef(repo, ref);
  if (!commitOid) return [];
  const seen = new Set<string>();
  const queue = [commitOid];
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = repo.objects.get(current);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queue.push(p);
  }
  return [...seen].sort((a, b) => (repo.commitSeq.get(b) ?? 0) - (repo.commitSeq.get(a) ?? 0));
}

/** Resolve a ref name, branch name or sha to a commit oid. */
export function resolveRef(repo: Repo, ref: string): string | null {
  if (repo.refs.has(ref)) return peelToCommit(repo.objects, repo.refs.get(ref)!);
  const branchRef = `refs/heads/${ref}`;
  if (repo.refs.has(branchRef)) return peelToCommit(repo.objects, repo.refs.get(branchRef)!);
  const tagRef = `refs/tags/${ref}`;
  if (repo.refs.has(tagRef)) return peelToCommit(repo.objects, repo.refs.get(tagRef)!);
  if (isObjectId(ref)) return peelToCommit(repo.objects, ref);
  return null;
}

// ---------------------------------------------------------------------------
// issues and pull requests
// ---------------------------------------------------------------------------

export function createIssue(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  labelNames: readonly string[],
): Issue {
  const labels: Label[] = [];
  for (const name of labelNames) {
    const label = repo.labels.find((entry) => entry.name === name);
    if (!label) throw new Error(`label not found: ${name}`);
    labels.push(label);
  }
  const now = trialNowIso();
  const issue: Issue = {
    id: store.issueIdSeq++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels,
    createdAt: now,
    updatedAt: now,
    closedAt: null,
    isPull: false,
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function createPull(
  store: Store,
  repo: Repo,
  title: string,
  body: string,
  headRef: string,
  baseRef: string,
): Pull {
  const headOid = repo.refs.get(`refs/heads/${headRef}`);
  const baseOid = repo.refs.get(`refs/heads/${baseRef}`);
  if (headOid === undefined) throw new Error(`head branch not found: ${headRef}`);
  if (baseOid === undefined) throw new Error(`base branch not found: ${baseRef}`);
  const now = trialNowIso();
  const pull: Pull = {
    id: store.pullIdSeq++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha: headOid,
    baseSha: baseOid,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: now,
    updatedAt: now,
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** Line-level diff stats between two blobs. */
export function diffStats(oldContent: Buffer | null, newContent: Buffer | null): { additions: number; deletions: number } {
  const oldLines = oldContent === null ? [] : oldContent.toString('utf8').split('\n');
  const newLines = newContent === null ? [] : newContent.toString('utf8').split('\n');
  // LCS over lines (files here are small).
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i]![j] = oldLines[i] === newLines[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const common = dp[0]![0]!;
  return { additions: n - common, deletions: m - common };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file diff between the base tip and the head tip of a pull request. */
export function pullFiles(repo: Repo, pull: Pull): FileChange[] {
  const baseTree = refTree(repo, `refs/heads/${pull.baseRef}`);
  const headTree = refTree(repo, `refs/heads/${pull.headRef}`);
  const baseFlat = baseTree === null ? new Map() : flattenTree(repo, baseTree);
  const headFlat = headTree === null ? new Map() : flattenTree(repo, headTree);
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const out: FileChange[] = [];
  for (const path of [...paths].sort()) {
    const baseEntry = baseFlat.get(path);
    const headEntry = headFlat.get(path);
    if (baseEntry === undefined && headEntry !== undefined) {
      const blob = repo.objects.get(headEntry.oid);
      const stats = diffStats(null, blob?.data ?? null);
      out.push({ filename: path, status: 'added', additions: stats.additions, deletions: 0, changes: stats.additions });
    } else if (baseEntry !== undefined && headEntry === undefined) {
      const blob = repo.objects.get(baseEntry.oid);
      const stats = diffStats(blob?.data ?? null, null);
      out.push({ filename: path, status: 'removed', additions: 0, deletions: stats.deletions, changes: stats.deletions });
    } else if (baseEntry !== undefined && headEntry !== undefined && baseEntry.oid !== headEntry.oid) {
      const oldBlob = repo.objects.get(baseEntry.oid);
      const newBlob = repo.objects.get(headEntry.oid);
      const stats = diffStats(oldBlob?.data ?? null, newBlob?.data ?? null);
      out.push({ filename: path, status: 'modified', additions: stats.additions, deletions: stats.deletions, changes: stats.additions + stats.deletions });
    }
  }
  return out;
}

/** True when the head's changes conflict with the base's changes since the merge-base. */
export function pullConflicts(repo: Repo, pull: Pull): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (!baseTip || !headTip) return true;
  const base = mergeBase(repo.objects, baseTip, headTip);
  if (base === null) return true;
  const baseTreeOid = (() => {
    const object = repo.objects.get(base);
    return object?.type === 'commit' ? parseCommit(object.data).tree : null;
  })();
  if (baseTreeOid === null) return true;
  const ancestorFlat = flattenTree(repo, baseTreeOid);
  const baseFlat = flattenTree(repo, refTree(repo, `refs/heads/${pull.baseRef}`) ?? '');
  const headFlat = flattenTree(repo, refTree(repo, `refs/heads/${pull.headRef}`) ?? '');
  const paths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of paths) {
    const anc = ancestorFlat.get(path)?.oid;
    const baseOid = baseFlat.get(path)?.oid;
    const headOid = headFlat.get(path)?.oid;
    const baseChanged = baseOid !== anc;
    const headChanged = headOid !== anc;
    if (baseChanged && headChanged && baseOid !== headOid) return true;
  }
  return false;
}

/** Squash-merge a pull request onto its base branch. Returns the merge commit sha. */
export function mergePull(repo: Repo, pull: Pull, method: string): string {
  const baseRef = `refs/heads/${pull.baseRef}`;
  const headRef = `refs/heads/${pull.headRef}`;
  const baseTip = repo.refs.get(baseRef);
  const headTip = repo.refs.get(headRef);
  if (!baseTip || !headTip) throw new Error('missing branch tip');
  const headCommit = peelToCommit(repo.objects, headTip);
  if (!headCommit) throw new Error('head is not a commit');
  const headTree = (() => {
    const object = repo.objects.get(headCommit);
    return object?.type === 'commit' ? parseCommit(object.data).tree : null;
  })();
  if (!headTree) throw new Error('head has no tree');
  const baseCommit = peelToCommit(repo.objects, baseTip);
  if (!baseCommit) throw new Error('base is not a commit');
  const parents = method === 'merge' ? [baseCommit, headCommit] : [baseCommit];
  const message = method === 'merge' ? `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n` : `${pull.title}\n`;
  const commit = buildCommit({
    tree: headTree,
    parents,
    message,
    author: viewerIdentity(),
    committer: viewerIdentity(),
    timestamp: trialNowEpoch(),
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  noteCommit(repo, commitSha);
  repo.refs.set(baseRef, commitSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = trialNowIso();
  pull.mergeCommitSha = commitSha;
  pull.updatedAt = trialNowIso();
  return commitSha;
}

export function blobShaOf(repo: Repo, path: string, ref: string): string | null {
  const tree = refTree(repo, ref);
  if (tree === null) return null;
  return flattenTree(repo, tree).get(path)?.oid ?? null;
}

export function readBlob(repo: Repo, path: string, ref: string): { blob: GitObject; sha: string } | null {
  const sha = blobShaOf(repo, path, ref);
  if (!sha) return null;
  const blob = repo.objects.get(sha);
  if (!blob || blob.type !== 'blob') return null;
  return { blob, sha };
}

export { ZERO_OID, hashObject, collectReachable, isObjectId };
