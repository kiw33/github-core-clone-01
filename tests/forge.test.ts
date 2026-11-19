// forge.test.ts — end-to-end tests over real HTTP against the forge.
// Boot the server on an ephemeral port and exercise git push/clone/fetch,
// REST, GraphQL and MCP the way the harness clients do.

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCommit,
  buildTree,
  decodePktLines,
  encodePktLine,
  encodePktLines,
  hashObject,
  pktDelim,
  pktFlush,
  putObject,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
} from '../git.ts';
import { createApp } from '../app.ts';
import { Store } from '../store.ts';

process.env.MAKEFUN_SHOP_TOKEN = 'test-token-123';
const TOKEN = 'test-token-123';

const store = new Store();
const server = createApp(store);
await new Promise<void>((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve());
});
const address = server.address();
if (address === null || typeof address === 'string') throw new Error('no port');
const BASE = `http://127.0.0.1:${address.port}`;

test.after(() => {
  server.close();
});

interface FetchOptions {
  method?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  token?: string | null;
  raw?: boolean;
}

async function api(path: string, options: FetchOptions = {}): Promise<{ status: number; headers: Headers; text: string; json: unknown; buffer: Buffer }> {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? TOKEN}`;
  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body as unknown as BodyInit | undefined,
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  const text = buffer.toString('utf8');
  let json: unknown = null;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, text, json, buffer };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function createRepo(name: string): Promise<Record<string, unknown>> {
  const res = await api('/api/v3/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, private: false, description: `repo ${name}` }),
  });
  assert.equal(res.status, 201, `create repo ${name}: ${res.text}`);
  assert.ok(isRecord(res.json));
  return res.json;
}

async function putFile(owner: string, repo: string, path: string, content: string, message: string, branch?: string, sha?: string): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = { message, content: b64(content) };
  if (branch !== undefined) body.branch = branch;
  if (sha !== undefined) body.sha = sha;
  const res = await api(`/api/v3/repos/${owner}/${repo}/contents/${path}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.ok(res.status === 201 || res.status === 200, `PUT contents ${path}: ${res.status} ${res.text}`);
  assert.ok(isRecord(res.json));
  return res.json;
}

// ---------------------------------------------------------------------------
// lifecycle / auth
// ---------------------------------------------------------------------------

test('healthz answers ok', async () => {
  const res = await fetch(`${BASE}/healthz`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('REST without a token is 401', async () => {
  const res = await api('/api/v3/user', { token: null });
  assert.equal(res.status, 401);
});

test('REST with a wrong token is 401', async () => {
  const res = await api('/api/v3/user', { token: 'wrong' });
  assert.equal(res.status, 401);
});

test('root carries X-OAuth-Scopes and meta reports a version', async () => {
  const root = await api('/api/v3/');
  assert.equal(root.status, 200);
  assert.match(root.headers.get('x-oauth-scopes') ?? '', /repo/);
  const meta = await api('/api/v3/meta');
  assert.equal(meta.status, 200);
  assert.ok(isRecord(meta.json) && typeof meta.json.installed_version === 'string' && meta.json.installed_version !== '');
});

test('every REST reply carries a request id and is JSON', async () => {
  const res = await api('/api/v3/user');
  assert.ok((res.headers.get('x-github-request-id') ?? '') !== '');
  assert.match(res.headers.get('content-type') ?? '', /application\/json/);
  const missing = await api('/api/v3/nope');
  assert.equal(missing.status, 404);
  assert.ok(isRecord(missing.json) && typeof missing.json.message === 'string');
});

// ---------------------------------------------------------------------------
// repos + contents
// ---------------------------------------------------------------------------

test('repos: create, duplicate 422, read, patch, delete', async () => {
  const repo = await createRepo('alpha');
  assert.equal(repo.name, 'alpha');
  assert.equal(repo.default_branch, 'main');
  assert.equal(repo.private, false);

  const dup = await api('/api/v3/user/repos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'alpha' }),
  });
  assert.equal(dup.status, 422);
  assert.match(String(isRecord(dup.json) ? dup.json.message : ''), /already exists/i);

  const read = await api('/api/v3/repos/adaiversen/alpha');
  assert.equal(read.status, 200);

  const patched = await api('/api/v3/repos/adaiversen/alpha', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'patched' }),
  });
  assert.equal(patched.status, 200);
  assert.ok(isRecord(patched.json) && patched.json.description === 'patched');

  const otherOwner = await api('/api/v3/repos/olgabauer/alpha');
  assert.equal(otherOwner.status, 404);

  const deleted = await api('/api/v3/repos/adaiversen/alpha', { method: 'DELETE' });
  assert.equal(deleted.status, 204);
  const gone = await api('/api/v3/repos/adaiversen/alpha');
  assert.equal(gone.status, 404);
});

test('contents: create on unborn repo, read, update, stale sha 409, delete, directory listing', async () => {
  await createRepo('beta');
  const created = await putFile('adaiversen', 'beta', 'docs/hello.txt', 'hello\n', 'add hello');
  assert.ok(isRecord(created.content) && typeof created.content.sha === 'string');
  assert.ok(isRecord(created.commit) && typeof created.commit.sha === 'string');

  const read = await api('/api/v3/repos/adaiversen/beta/contents/docs/hello.txt');
  assert.equal(read.status, 200);
  assert.ok(isRecord(read.json));
  assert.equal(read.json.encoding, 'base64');
  assert.equal(Buffer.from(String(read.json.content), 'base64').toString('utf8'), 'hello\n');
  assert.equal(read.json.size, 6);
  const blobSha = String(read.json.sha);

  const stale = await api('/api/v3/repos/adaiversen/beta/contents/docs/hello.txt', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'stale', content: b64('x\n'), sha: '0'.repeat(40) }),
  });
  assert.equal(stale.status, 409);

  const updated = await putFile('adaiversen', 'beta', 'docs/hello.txt', 'hello world\n', 'update', undefined, blobSha);
  assert.ok(isRecord(updated.content) && updated.content.sha !== blobSha);

  const listing = await api('/api/v3/repos/adaiversen/beta/contents/docs');
  assert.equal(listing.status, 200);
  assert.ok(Array.isArray(listing.json) && listing.json.length === 1);

  const rootListing = await api('/api/v3/repos/adaiversen/beta/contents/');
  assert.equal(rootListing.status, 200);
  assert.ok(Array.isArray(rootListing.json));

  const branches = await api('/api/v3/repos/adaiversen/beta/branches');
  assert.equal(branches.status, 200);
  assert.ok(Array.isArray(branches.json) && branches.json.length === 1);

  const commits = await api('/api/v3/repos/adaiversen/beta/commits');
  assert.equal(commits.status, 200);
  assert.ok(Array.isArray(commits.json) && commits.json.length === 2);
  assert.equal((commits.json[0] as Record<string, unknown>).sha, (updated.commit as Record<string, unknown>).sha);

  const deleted = await api('/api/v3/repos/adaiversen/beta/contents/docs/hello.txt', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: 'remove', sha: String((updated.content as Record<string, unknown>).sha) }),
  });
  assert.equal(deleted.status, 200);
  const gone = await api('/api/v3/repos/adaiversen/beta/contents/docs/hello.txt');
  assert.equal(gone.status, 404);
});

test('commits: ?sha=<branch name> lists branch-only commits; base list excludes them', async () => {
  await createRepo('kappa');
  await putFile('adaiversen', 'kappa', 'base.txt', 'base\n', 'base commit');
  const branchOnly = await putFile('adaiversen', 'kappa', 'branch.txt', 'branch\n', 'branch commit', 'feature');
  const branchSha = String((branchOnly.commit as Record<string, unknown>).sha);

  const branchList = await api('/api/v3/repos/adaiversen/kappa/commits?sha=feature');
  assert.equal(branchList.status, 200);
  assert.ok(Array.isArray(branchList.json));
  assert.ok((branchList.json as Array<Record<string, unknown>>).some((c) => c.sha === branchSha));
  const first = (branchList.json as Array<Record<string, unknown>>)[0]!;
  assert.equal((first.commit as Record<string, unknown>).message, 'branch commit');

  const baseList = await api('/api/v3/repos/adaiversen/kappa/commits');
  assert.equal(baseList.status, 200);
  assert.ok(!(baseList.json as Array<Record<string, unknown>>).some((c) => c.sha === branchSha));

  const byOid = await api(`/api/v3/repos/adaiversen/kappa/commits?sha=${branchSha}`);
  assert.ok((byOid.json as Array<Record<string, unknown>>).some((c) => c.sha === branchSha));
});

test('pagination: per_page caps items and Link rel=next is absolute', async () => {
  for (let i = 0; i < 12; i += 1) await createRepo(`page-${String(i).padStart(2, '0')}`);
  const first = await api('/api/v3/user/repos?per_page=10');
  assert.equal(first.status, 200);
  assert.ok(Array.isArray(first.json) && first.json.length === 10);
  const link = first.headers.get('link') ?? '';
  assert.match(link, /rel="next"/);
  assert.match(link, /^<http:\/\/127\.0\.0\.1:\d+\/api\/v3\/user\/repos\?[^>]*page=2[^>]*>/);
  const second = await api('/api/v3/user/repos?per_page=10&page=2');
  assert.equal(second.status, 200);
  assert.ok(Array.isArray(second.json) && (second.json as unknown[]).length >= 2);
  const firstNames = new Set((first.json as Array<Record<string, unknown>>).map((r) => r.name));
  for (const repo of second.json as Array<Record<string, unknown>>) assert.ok(!firstNames.has(repo.name));
});

// ---------------------------------------------------------------------------
// issues, labels, comments, pulls
// ---------------------------------------------------------------------------

test('issues and pulls share one counter; labels gate issue creation', async () => {
  await createRepo('gamma');
  const label = await api('/api/v3/repos/adaiversen/gamma/labels', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bug', color: 'd73a4a' }),
  });
  assert.equal(label.status, 201);

  const badLabel = await api('/api/v3/repos/adaiversen/gamma/issues', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'nope', labels: ['missing'] }),
  });
  assert.equal(badLabel.status, 422);

  const issue = await api('/api/v3/repos/adaiversen/gamma/issues', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'first bug', body: 'details', labels: ['bug'] }),
  });
  assert.equal(issue.status, 201);
  assert.ok(isRecord(issue.json) && issue.json.number === 1 && issue.json.state === 'open');

  const comment = await api('/api/v3/repos/adaiversen/gamma/issues/1/comments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: 'looking into it' }),
  });
  assert.equal(comment.status, 201);
  assert.ok(isRecord(comment.json) && comment.json.body === 'looking into it');

  const comments = await api('/api/v3/repos/adaiversen/gamma/issues/1/comments');
  assert.equal(comments.status, 200);
  assert.ok(Array.isArray(comments.json) && comments.json.length === 1);

  const closed = await api('/api/v3/repos/adaiversen/gamma/issues/1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
  assert.equal(closed.status, 200);
  assert.ok(isRecord(closed.json) && closed.json.state === 'closed');

  const openList = await api('/api/v3/repos/adaiversen/gamma/issues?state=open');
  assert.ok(Array.isArray(openList.json) && openList.json.length === 0);
  const allList = await api('/api/v3/repos/adaiversen/gamma/issues?state=all');
  assert.ok(Array.isArray(allList.json) && allList.json.length === 1);

  // The shared counter: the next pull request takes number 2, after issue 1.
  const base = await putFile('adaiversen', 'gamma', 'a.txt', 'a\n', 'base');
  const baseSha = String((base.commit as Record<string, unknown>).sha);
  const branchRes = await api('/api/v3/repos/adaiversen/gamma/git/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'refs/heads/feature', sha: baseSha }),
  });
  assert.equal(branchRes.status, 201, branchRes.text);
  const pr = await api('/api/v3/repos/adaiversen/gamma/pulls', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'shared counter', head: 'feature', base: 'main' }),
  });
  assert.equal(pr.status, 201, pr.text);
  assert.ok(isRecord(pr.json) && pr.json.number === 2);
});

test('pull request: files, squash merge, merged state, conflict 405', async () => {
  await createRepo('delta');
  const base = await putFile('adaiversen', 'delta', 'app.txt', 'line one\nline two\n', 'base commit');
  const baseSha = String((base.commit as Record<string, unknown>).sha);

  const branchRes = await api('/api/v3/repos/adaiversen/delta/git/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'refs/heads/feature', sha: baseSha }),
  });
  assert.equal(branchRes.status, 201, branchRes.text);

  await putFile('adaiversen', 'delta', 'app.txt', 'line one\nline two changed\n', 'head change', 'feature');
  await putFile('adaiversen', 'delta', 'new.txt', 'brand new\n', 'head adds file', 'feature');

  const pr = await api('/api/v3/repos/adaiversen/delta/pulls', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'change app', head: 'feature', base: 'main' }),
  });
  assert.equal(pr.status, 201, pr.text);
  assert.ok(isRecord(pr.json) && pr.json.number === 1);

  const files = await api('/api/v3/repos/adaiversen/delta/pulls/1/files');
  assert.equal(files.status, 200);
  assert.ok(Array.isArray(files.json));
  const names = (files.json as Array<Record<string, unknown>>).map((f) => f.filename);
  assert.ok(names.includes('app.txt') && names.includes('new.txt'));
  const appFile = (files.json as Array<Record<string, unknown>>).find((f) => f.filename === 'app.txt')!;
  assert.ok(typeof appFile.additions === 'number' && appFile.additions >= 1);

  const dup = await api('/api/v3/repos/adaiversen/delta/pulls', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'again', head: 'feature', base: 'main' }),
  });
  assert.equal(dup.status, 422);

  const merged = await api('/api/v3/repos/adaiversen/delta/pulls/1/merge', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  assert.equal(merged.status, 200, merged.text);
  assert.ok(isRecord(merged.json) && merged.json.merged === true && typeof merged.json.sha === 'string');

  const after = await api('/api/v3/repos/adaiversen/delta/pulls/1');
  assert.ok(isRecord(after.json) && after.json.state === 'closed' && after.json.merged === true);
  assert.equal(after.json.merge_commit_sha, merged.json.sha);

  const mergedContent = await api('/api/v3/repos/adaiversen/delta/contents/app.txt?ref=main');
  assert.equal(Buffer.from(String((mergedContent.json as Record<string, unknown>).content), 'base64').toString('utf8'), 'line one\nline two changed\n');

  // Conflict: same file changed differently on both sides.
  await createRepo('epsilon');
  const base2 = await putFile('adaiversen', 'epsilon', 'f.txt', 'base\n', 'base');
  const base2Sha = String((base2.commit as Record<string, unknown>).sha);
  await api('/api/v3/repos/adaiversen/epsilon/git/refs', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'refs/heads/feature', sha: base2Sha }),
  });
  await putFile('adaiversen', 'epsilon', 'f.txt', 'head\n', 'head change', 'feature');
  const pr2 = await api('/api/v3/repos/adaiversen/epsilon/pulls', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'conflict pr', head: 'feature', base: 'main' }),
  });
  assert.equal(pr2.status, 201);
  const current = await api('/api/v3/repos/adaiversen/epsilon/contents/f.txt');
  await putFile('adaiversen', 'epsilon', 'f.txt', 'base2\n', 'base change', undefined, String((current.json as Record<string, unknown>).sha));
  const conflictMerge = await api('/api/v3/repos/adaiversen/epsilon/pulls/1/merge', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  assert.equal(conflictMerge.status, 405);
  const unknownPr = await api('/api/v3/repos/adaiversen/epsilon/pulls/99/merge', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  assert.equal(unknownPr.status, 404);
});

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function makeCommit(objects: Map<string, GitObject>, blobContent: string, parents: string[]): { commit: string; tree: string; blob: string } {
  const blob = putObject(objects, 'blob', Buffer.from(blobContent, 'utf8'));
  const tree = putObject(objects, 'tree', buildTree([{ mode: '100644', name: 'file.txt', oid: blob }]));
  const commit = putObject(objects, 'commit', buildCommit({
    tree,
    parents,
    message: `commit ${blobContent.trim()}\n`,
    author: 'ada iversen <adaiversen@example.invalid> 1763097000 +0000',
    committer: 'ada iversen <adaiversen@example.invalid> 1763097000 +0000',
    timestamp: 1763097000,
  }));
  return { commit, tree, blob };
}

async function pushPack(repo: string, oldSha: string, newSha: string, ref: string, objects: GitObject[]): Promise<{ status: number; text: string }> {
  const pack = writePack(objects);
  const firstLine = `${oldSha} ${newSha} ${ref}\0report-status side-band-64k ofs-delta agent=forge/1.0`;
  const body = Buffer.concat([encodePktLine(firstLine), pktFlush(), pack]);
  const res = await api(`/adaiversen/${repo}.git/git-receive-pack`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body,
  });
  return { status: res.status, text: res.text };
}

test('git: push, advertise, ls-refs, fetch v2 and v0, shallow, non-fast-forward', async () => {
  await createRepo('zeta');
  const objects = new Map<string, GitObject>();
  const c1 = makeCommit(objects, 'one\n', []);
  const packObjects = [...objects.values()];
  assert.equal(hashObject('blob', Buffer.from('one\n', 'utf8')), c1.blob);

  const pushed = await pushPack('zeta', ZERO_OID, c1.commit, 'refs/heads/main', packObjects);
  assert.equal(pushed.status, 200, pushed.text);
  assert.match(pushed.text, /unpack ok/);
  assert.match(pushed.text, /ok refs\/heads\/main/);

  const adv = await api('/adaiversen/zeta.git/info/refs?service=git-upload-pack', {
    headers: { 'git-protocol': 'version=2' },
  });
  assert.equal(adv.status, 200);
  assert.match(adv.headers.get('content-type') ?? '', /x-git-upload-pack-advertisement/);
  // v2 advertisement carries capabilities only; refs come from ls-refs.
  assert.ok(adv.text.includes('version 2'));
  assert.ok(adv.text.includes('ls-refs=unborn'));

  const adv0 = await api('/adaiversen/zeta.git/info/refs?service=git-upload-pack');
  assert.equal(adv0.status, 200);
  assert.ok(adv0.text.includes(c1.commit));

  const missing = await api('/adaiversen/nope.git/info/refs?service=git-upload-pack');
  assert.equal(missing.status, 404);

  // v2 ls-refs
  const lsBody = encodePktLines([
    'command=ls-refs',
    'agent=forge-test/1.0',
    'object-format=sha1',
    'delim',
    'peel',
    'symrefs',
    'unborn',
    'flush',
  ]);
  const ls = await api('/adaiversen/zeta.git/git-upload-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: lsBody,
  });
  assert.equal(ls.status, 200, ls.text);
  const { packets: lsPackets } = decodePktLines(ls.buffer);
  const lsText = lsPackets.filter((e) => e.kind === 'data').map((e) => e.payload.toString('utf8')).join('\n');
  assert.ok(lsText.includes(`${c1.commit} refs/heads/main`));

  // v2 fetch (full)
  const fetchBody = encodePktLines([
    'command=fetch',
    'agent=forge-test/1.0',
    'delim',
    'thin-pack',
    'no-progress',
    'ofs-delta',
    `want ${c1.commit}`,
    'done',
    'flush',
  ]);
  const fetched = await api('/adaiversen/zeta.git/git-upload-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: fetchBody,
  });
  assert.equal(fetched.status, 200);
  const packBytes = extractSidebandPack(fetched.buffer);
  const received = readPack(packBytes);
  assert.equal(received.size, 3);
  assert.ok(received.has(c1.commit));

  // v2 fetch with deepen 1 on a two-commit history returns a shallow line.
  // d2 is a child of c1, so the push is a fast-forward.
  const objects2 = new Map<string, GitObject>();
  const d2 = makeCommit(objects2, 'd2\n', [c1.commit]);
  const pushed2 = await pushPack('zeta', c1.commit, d2.commit, 'refs/heads/main', [...objects2.values()]);
  assert.equal(pushed2.status, 200, pushed2.text);
  const shallowBody = encodePktLines([
    'command=fetch',
    'agent=forge-test/1.0',
    'delim',
    'thin-pack',
    'no-progress',
    'ofs-delta',
    `want ${d2.commit}`,
    'deepen 1',
    'done',
    'flush',
  ]);
  const shallow = await api('/adaiversen/zeta.git/git-upload-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request', 'git-protocol': 'version=2' },
    body: shallowBody,
  });
  assert.equal(shallow.status, 200);
  assert.ok(shallow.text.includes(`shallow ${d2.commit}`), shallow.text);

  // v0 fetch
  const v0Body = Buffer.concat([
    encodePktLine(`want ${d2.commit} agent=forge-test/1.0`),
    pktFlush(),
    encodePktLine('done'),
    pktFlush(),
  ]);
  const v0 = await api('/adaiversen/zeta.git/git-upload-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-upload-pack-request' },
    body: v0Body,
  });
  assert.equal(v0.status, 200);
  const v0Pack = extractSidebandPack(v0.buffer);
  assert.ok(readPack(v0Pack).has(d2.commit));

  // Non-fast-forward push is refused with the exact reason string.
  const objects3 = new Map<string, GitObject>();
  const other = makeCommit(objects3, 'other-root\n', []);
  const refused = await pushPack('zeta', d2.commit, other.commit, 'refs/heads/main', [...objects3.values()]);
  assert.equal(refused.status, 200, refused.text);
  assert.match(refused.text, /ng refs\/heads\/main non-fast-forward/);
  // The refused objects were still unpacked.
  const stillThere = await api('/adaiversen/zeta.git/info/refs?service=git-upload-pack');
  assert.ok(stillThere.text.includes(d2.commit));

  // Malformed receive-pack body is a 400 and the server stays up.
  const bad = await api('/adaiversen/zeta.git/git-receive-pack', {
    method: 'POST',
    headers: { 'content-type': 'application/x-git-receive-pack-request' },
    body: Buffer.from('zzzznot-a-pkt-line'),
  });
  assert.equal(bad.status, 400);
  const alive = await fetch(`${BASE}/healthz`);
  assert.equal(alive.status, 200);
});

/** Pull the band-1 sideband bytes out of an upload-pack response. */
function extractSidebandPack(response: Buffer): Buffer {
  const { packets } = decodePktLines(response, { allowTrailing: true });
  const chunks: Buffer[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data' && packet.payload.length > 0 && packet.payload[0] === 1) {
      chunks.push(packet.payload.subarray(1));
    }
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------------------
// GraphQL
// ---------------------------------------------------------------------------

async function gql(query: string, variables: Record<string, unknown> = {}, token?: string | null): Promise<{ status: number; json: unknown }> {
  const res = await api('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    token,
  });
  return { status: res.status, json: res.json };
}

test('graphql: viewer, repository, introspection, mutations, errors, batch', async () => {
  const unauth = await gql('{ viewer { login } }', {}, null);
  assert.equal(unauth.status, 401);

  const viewer = await gql('query ViewerLogin { viewer { login } }');
  assert.equal(viewer.status, 200);
  assert.equal((viewer.json as Record<string, unknown>).data !== null && ((viewer.json as Record<string, unknown>).data as Record<string, unknown>).viewer !== null ? (((viewer.json as Record<string, unknown>).data as Record<string, unknown>).viewer as Record<string, unknown>).login : null, 'adaiversen');

  await createRepo('theta');
  await putFile('adaiversen', 'theta', 'readme.md', '# theta\n', 'init');

  const repoQuery = await gql(
    'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id databaseId name owner { login } defaultBranchRef { name } viewerPermission hasIssuesEnabled } }',
    { owner: 'adaiversen', name: 'theta' },
  );
  const repoData = (repoQuery.json as Record<string, unknown>).data as Record<string, unknown>;
  const repository = repoData.repository as Record<string, unknown>;
  assert.equal(repository.name, 'theta');
  assert.equal((repository.owner as Record<string, unknown>).login, 'adaiversen');
  assert.equal((repository.defaultBranchRef as Record<string, unknown>).name, 'main');
  assert.equal(repository.viewerPermission, 'ADMIN');
  assert.equal(repository.hasIssuesEnabled, true);
  const repoGlobalId = String(repository.id);

  const unknownRepo = await gql('{ repository(owner: "adaiversen", name: "nope") { name } }');
  assert.equal(((unknownRepo.json as Record<string, unknown>).data as Record<string, unknown>).repository, null);
  assert.equal((unknownRepo.json as Record<string, unknown>).errors, undefined);

  const introspect = await gql('{ __type(name: "Issue") { fields { name } } }');
  const issueFields = (((introspect.json as Record<string, unknown>).data as Record<string, unknown>).__type as Record<string, unknown>).fields as Array<Record<string, unknown>>;
  const fieldNames = issueFields.map((f) => f.name);
  for (const expected of ['id', 'number', 'title', 'state', 'body']) assert.ok(fieldNames.includes(expected));

  const create = await gql(
    'mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
    { input: { repositoryId: repoGlobalId, title: 'gql issue', body: 'from graphql' } },
  );
  const createdIssue = (((create.json as Record<string, unknown>).data as Record<string, unknown>).createIssue as Record<string, unknown>).issue as Record<string, unknown>;
  assert.equal(createdIssue.number, 1);

  const readBack = await api('/api/v3/repos/adaiversen/theta/issues/1');
  assert.equal(readBack.status, 200);
  assert.equal((readBack.json as Record<string, unknown>).title, 'gql issue');

  const close = await gql(
    'mutation CloseIssue($input: CloseIssueInput!) { closeIssue(input: $input) { issue { number state } } }',
    { input: { issueId: String(createdIssue.id) } },
  );
  const closedIssue = (((close.json as Record<string, unknown>).data as Record<string, unknown>).closeIssue as Record<string, unknown>).issue as Record<string, unknown>;
  assert.equal(closedIssue.state, 'CLOSED');

  const invalid = await gql('{ viewer { noSuchFieldOnViewer } }');
  assert.equal(invalid.status, 200);
  const errors = (invalid.json as Record<string, unknown>).errors as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(errors) && errors.length > 0);
  assert.match(String(errors[0]!.message), /noSuchFieldOnViewer/);

  const batch = await api('/api/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([
      { query: '{ viewer { login } }' },
      { query: '{ repository(owner: "adaiversen", name: "theta") { name } }' },
    ]),
  });
  assert.equal(batch.status, 200);
  assert.ok(Array.isArray(batch.json) && batch.json.length === 2);

  const node = await gql(
    'query NodeRepository($id: ID!) { node(id: $id) { ... on Repository { name nameWithOwner } } }',
    { id: repoGlobalId },
  );
  const nodeData = ((node.json as Record<string, unknown>).data as Record<string, unknown>).node as Record<string, unknown>;
  assert.equal(nodeData.name, 'theta');
  assert.equal(nodeData.nameWithOwner, 'adaiversen/theta');
});

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

async function rpc(body: unknown, token?: string | null): Promise<{ status: number; json: unknown; text: string }> {
  const res = await api('/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
    token,
  });
  return { status: res.status, json: res.json, text: res.text };
}

test('mcp: discover, initialize, tools/list stability, tools/call, errors', async () => {
  const unauth = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, null);
  assert.equal(unauth.status, 401);

  const discover = await rpc({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  assert.equal(discover.status, 200);
  const discoverResult = (discover.json as Record<string, unknown>).result as Record<string, unknown>;
  assert.ok(Array.isArray(discoverResult.supportedVersions) && (discoverResult.supportedVersions as string[]).includes('2026-07-28'));
  assert.ok(isRecord(discoverResult.capabilities));

  const init = await rpc({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
  assert.equal(init.status, 200);
  assert.ok(isRecord((init.json as Record<string, unknown>).result));

  const notified = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(notified.status, 202);

  const list1 = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
  const list2 = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/list', params: {} });
  const tools1 = ((list1.json as Record<string, unknown>).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  const tools2 = ((list2.json as Record<string, unknown>).result as Record<string, unknown>).tools as Array<Record<string, unknown>>;
  assert.equal(JSON.stringify(tools1), JSON.stringify(tools2));
  const names = tools1.map((t) => t.name);
  for (const needed of ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request']) {
    assert.ok(names.includes(needed), `missing tool ${needed}`);
  }
  assert.ok(tools1.length >= 6);

  const created = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'create_repo', arguments: { name: 'iota' } } });
  const createdResult = (created.json as Record<string, unknown>).result as Record<string, unknown>;
  assert.equal((createdResult.structuredContent as Record<string, unknown>).full_name, 'adaiversen/iota');

  const issue = await rpc({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'iota', title: 'mcp issue' } } });
  const issueResult = (issue.json as Record<string, unknown>).result as Record<string, unknown>;
  assert.equal((issueResult.structuredContent as Record<string, unknown>).number, 1);

  const listed = await rpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'iota' } } });
  const listedResult = (listed.json as Record<string, unknown>).result as Record<string, unknown>;
  const listedText = ((listedResult.content as Array<Record<string, unknown>>)[0]!.text as string);
  assert.ok(listedText.includes('mcp issue'));

  const unknown = await rpc({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'nope_tool', arguments: {} } });
  assert.equal(((unknown.json as Record<string, unknown>).error as Record<string, unknown>).code, -32602);

  const unknownMethod = await rpc({ jsonrpc: '2.0', id: 9, method: 'bogus/method', params: {} });
  assert.equal(((unknownMethod.json as Record<string, unknown>).error as Record<string, unknown>).code, -32601);

  const parseError = await rpc('{not json', undefined);
  assert.equal(parseError.status, 400);
  assert.equal(((parseError.json as Record<string, unknown>).error as Record<string, unknown>).code, -32700);

  const missingArgs = await rpc({ jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'create_issue', arguments: { owner: 'adaiversen', repo: 'iota' } } });
  const missingResult = (missingArgs.json as Record<string, unknown>).result as Record<string, unknown>;
  assert.equal(missingResult.isError, true);
});
