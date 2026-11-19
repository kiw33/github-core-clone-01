// app.ts — the HTTP server: GitHub REST v3 under /api/v3, GraphQL under
// /api/graphql, MCP under /mcp, and the git smart-HTTP endpoints under
// /{owner}/{repo}.git. Every reply is JSON except the git protocol bytes.
// Every API reply carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  advertiseV0,
  advertiseV2,
  decodePktLines,
  fetchV0Response,
  fetchV2Response,
  isObjectId,
  lsRefsResponse,
  parseFetchArgs,
  parseFetchArgsV0,
  parseLsRefsArgs,
  parseReceivePack,
  receivePackResponse,
} from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpBody } from './mcp.ts';
import {
  blobShaOf,
  commitFile,
  createIssue,
  createPull,
  deleteFile,
  flattenTree,
  listCommits,
  mergePull,
  pullConflicts,
  pullFiles,
  refTree,
  Store,
  trialNowIso,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Repo,
} from './store.ts';

const MAX_BODY = 128 * 1024 * 1024;

let requestCounter = 0;
function requestId(): string {
  requestCounter += 1;
  return `req_${requestCounter.toString(16)}_${process.hrtime.bigint().toString(16)}`;
}

export function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true; // no token configured (local dev): open
  const header = req.headers.authorization ?? '';
  return header === `Bearer ${token}`;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId(),
    ...extra,
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function parseJsonBody(body: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(body.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

function repoPayload(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 0, type: 'User', avatar_url: '', html_url: `https://github.com/${repo.owner}` },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
  };
}

function issuePayload(repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }>; createdAt: string; updatedAt: string; closedAt: string | null }): Record<string, unknown> {
  return {
    id: issue.number,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ id: label.name, name: label.name, color: label.color, description: '' })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.closedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullPayload(repo: Repo, pull: { number: number; title: string; body: string; state: string; headRef: string; baseRef: string; headSha: string; baseSha: string; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null; createdAt: string; updatedAt: string }): Record<string, unknown> {
  return {
    id: pull.number,
    node_id: `PR_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? true : null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function pageParams(url: URL): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(url.searchParams.get('page') ?? '1', 10) || 1);
  const perPageRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) ? Math.min(100, Math.max(1, perPageRaw)) : 30;
  return { page, perPage };
}

function linkHeader(req: IncomingMessage, url: URL, page: number, perPage: number, hasNext: boolean): string | null {
  if (!hasNext) return null;
  const host = req.headers.host ?? 'localhost';
  const proto = 'http';
  const next = new URL(url.toString());
  next.searchParams.set('page', String(page + 1));
  next.searchParams.set('per_page', String(perPage));
  const absolute = `${proto}://${host}${next.pathname}${next.search}`;
  return `<${absolute}>; rel="next"`;
}

function paginate<T>(items: T[], page: number, perPage: number): { pageItems: T[]; hasNext: boolean } {
  const start = (page - 1) * perPage;
  const pageItems = items.slice(start, start + perPage);
  return { pageItems, hasNext: items.length > start + perPage };
}

/** Decode a path segment; returns null on bad percent-encoding. */
function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function createApp(store: Store = new Store()): ReturnType<typeof createServer> {
  const server = createServer((req, res) => {
    void handleRequest(store, req, res).catch((err: unknown) => {
      if (!res.headersSent) {
        sendError(res, 500, err instanceof Error ? err.message : 'internal error');
      } else {
        res.destroy();
      }
    });
  });
  return server;
}

async function handleRequest(store: Store, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method ?? 'GET';
  const rawUrl = req.url ?? '/';
  const url = new URL(rawUrl, 'http://localhost');
  const pathname = url.pathname;

  if (method === 'GET' && pathname === '/healthz') {
    sendJson(res, 200, { ok: true });
    return;
  }

  // -- MCP ---------------------------------------------------------------
  if (pathname === '/mcp') {
    if (method === 'DELETE') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (method !== 'POST') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } });
      return;
    }
    const body = await readBody(req);
    const outcome = handleMcpBody(store, body.toString('utf8'));
    if (outcome === null) {
      res.writeHead(202);
      res.end();
      return;
    }
    const batch = (outcome as { __batch?: unknown[] }).__batch;
    if (Array.isArray(batch)) {
      sendJson(res, 200, batch);
      return;
    }
    // A body that is not JSON is HTTP 400 with JSON-RPC -32700 (the
    // pre-2026-07-28 transport answered 200; this server is modern).
    const error = (outcome as { error?: { code?: unknown } }).error;
    if (error !== undefined && error !== null && typeof error === 'object' && error.code === -32700) {
      sendJson(res, 400, outcome);
      return;
    }
    sendJson(res, 200, outcome);
    return;
  }

  // -- GraphQL -----------------------------------------------------------
  if (pathname === '/api/graphql') {
    if (method !== 'POST') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON');
      return;
    }
    const runOne = (entry: unknown): unknown => {
      if (entry === null || typeof entry !== 'object') {
        return { data: null, errors: [{ message: 'expected an object' }] };
      }
      const record = entry as Record<string, unknown>;
      const query = record.query;
      if (typeof query !== 'string') {
        return { data: null, errors: [{ message: 'query must be a string' }] };
      }
      const variables = (record.variables ?? {}) as Record<string, unknown>;
      return executeGraphQL(store, query, variables);
    };
    if (Array.isArray(parsed.value)) {
      sendJson(res, 200, parsed.value.map((entry) => runOne(entry)));
    } else {
      sendJson(res, 200, runOne(parsed.value));
    }
    return;
  }

  // -- REST v3 -----------------------------------------------------------
  if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
    await handleRest(store, req, res, method, url);
    return;
  }

  // -- git smart HTTP ----------------------------------------------------
  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (gitMatch) {
    const owner = decodeSegment(gitMatch[1]!);
    const repoName = decodeSegment(gitMatch[2]!);
    const rest = gitMatch[3] ?? '';
    if (owner === null || repoName === null) {
      sendError(res, 400, 'bad repository path');
      return;
    }
    if (!authorized(req)) {
      sendError(res, 401, 'Requires authentication');
      return;
    }
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleGit(repo, req, res, method, url, rest);
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

async function handleGit(
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  rest: string,
): Promise<void> {
  const service = url.searchParams.get('service') ?? '';
  const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';

  if (method === 'GET' && rest === '/info/refs') {
    if (service === 'git-upload-pack') {
      if (isV2) {
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'x-github-request-id': requestId() });
        res.end(advertiseV2());
      } else {
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-advertisement', 'x-github-request-id': requestId() });
        res.end(advertiseV0(repo, 'git-upload-pack'));
      }
      return;
    }
    if (service === 'git-receive-pack') {
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-advertisement', 'x-github-request-id': requestId() });
      res.end(advertiseV0(repo, 'git-receive-pack'));
      return;
    }
    sendError(res, 400, 'unknown service');
    return;
  }

  if (method === 'POST' && rest === '/git-upload-pack') {
    const body = await readBody(req);
    try {
      if (isV2) {
        // v2 multiplexes commands over one endpoint: dispatch on the
        // first pkt-line.
        const { packets } = decodePktLines(body);
        const first = packets.find((packet) => packet.kind === 'data');
        const command = first ? first.payload.toString('utf8').replace(/\n$/, '') : '';
        let out: Buffer;
        if (command.startsWith('command=ls-refs')) {
          out = lsRefsResponse(repo, parseLsRefsArgs(body));
        } else if (command.startsWith('command=fetch')) {
          out = fetchV2Response(repo, parseFetchArgs(body));
        } else {
          sendError(res, 400, `unknown v2 command: ${command}`);
          return;
        }
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': requestId() });
        res.end(out);
      } else {
        const out = fetchV0Response(repo, parseFetchArgsV0(body));
        res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'x-github-request-id': requestId() });
        res.end(out);
      }
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'bad request');
    }
    return;
  }

  if (method === 'POST' && rest === '/git-receive-pack') {
    const body = await readBody(req);
    try {
      // A body that is not pkt-line commands at all (e.g. `zzzz...`) is a
      // 400; a well-formed body whose refs are refused still answers 200
      // with a report-status body.
      const parsed = parseReceivePack(body);
      if (parsed.commands.length === 0) {
        sendError(res, 400, 'malformed receive-pack body: no commands');
        return;
      }
      // receivePackResponse unpacks the pack itself (objects are stored
      // even for refused refs), validates the commands and builds the
      // report-status body.
      const response = receivePackResponse(repo, body);
      // Register creation order for any newly unpacked commits.
      for (const [oid, object] of repo.objects) {
        if (object.type === 'commit' && !repo.commitSeq.has(oid)) {
          repo.commitSeqCounter += 1;
          repo.commitSeq.set(oid, repo.commitSeqCounter);
        }
      }
      res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'x-github-request-id': requestId() });
      res.end(response);
    } catch (err) {
      sendError(res, 400, err instanceof Error ? err.message : 'bad request');
    }
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const pathname = url.pathname;
  const segments = pathname
    .slice('/api/v3'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeSegment(segment) ?? '');

  if (!authorized(req)) {
    sendError(res, 401, 'Requires authentication');
    return;
  }

  // GET /api/v3/ — root
  if (segments.length === 0) {
    if (method !== 'GET') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    sendJson(res, 200, { current_user_url: '/api/v3/user' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }

  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: false });
    return;
  }

  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      sendError(res, 405, 'method not allowed');
      return;
    }
    sendJson(res, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      avatar_url: '',
      html_url: `https://github.com/${VIEWER_LOGIN}`,
      type: 'User',
    });
    return;
  }

  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const name = input.name;
      if (typeof name !== 'string' || name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      if (store.getRepo(VIEWER_LOGIN, name)) {
        sendError(res, 422, `Repository ${VIEWER_LOGIN}/${name} already exists`);
        return;
      }
      const repo = store.createRepo(name, input.private === true, typeof input.description === 'string' ? input.description : '');
      sendJson(res, 201, repoPayload(repo));
      return;
    }
    if (method === 'GET') {
      const { page, perPage } = pageParams(url);
      const repos = store.viewerRepos();
      const { pageItems, hasNext } = paginate(repos, page, perPage);
      const link = linkHeader(req, url, page, perPage, hasNext);
      sendJson(res, 200, pageItems.map((repo) => repoPayload(repo)), link ? { link } : {});
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  // /api/v3/repos/{owner}/{repo}[...]
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1]!;
    const repoName = segments[2]!;
    const tail = segments.slice(3);
    const repo = store.getRepo(owner, repoName);
    if (!repo) {
      sendError(res, 404, 'Not Found');
      return;
    }
    await handleRepoRest(store, repo, req, res, method, url, tail);
    return;
  }

  sendError(res, 404, 'Not Found');
}

async function handleRepoRest(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  tail: string[],
): Promise<void> {
  const owner = repo.owner;
  const repoName = repo.name;

  // Repo object itself.
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoPayload(repo));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.private = input.private;
      if (typeof input.default_branch === 'string' && input.default_branch !== '') repo.defaultBranch = input.default_branch;
      repo.updatedAt = trialNowIso();
      sendJson(res, 200, repoPayload(repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  // Branches.
  if (tail[0] === 'branches') {
    if (tail.length === 1 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length))
        .sort()
        .map((name) => ({ name, commit: { sha: repo.refs.get(`refs/heads/${name}`)! } }));
      sendJson(res, 200, branches);
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const branch = tail[1]!;
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { name: branch, commit: { sha } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Commits.
  if (tail[0] === 'commits') {
    if (tail.length === 1 && method === 'GET') {
      const shaParam = url.searchParams.get('sha');
      const ref = shaParam ?? `refs/heads/${repo.defaultBranch}`;
      const commits = listCommits(repo, ref);
      const { page, perPage } = pageParams(url);
      const { pageItems, hasNext } = paginate(commits, page, perPage);
      const link = linkHeader(req, url, page, perPage, hasNext);
      sendJson(res, 200, pageItems.map((sha) => ({
        sha,
        commit: { message: commitMessage(repo, sha) },
        html_url: `https://github.com/${owner}/${repoName}/commit/${sha}`,
      })), link ? { link } : {});
      return;
    }
    if (tail.length === 2 && method === 'GET') {
      const sha = tail[1]!;
      if (!isObjectId(sha)) {
        sendError(res, 404, 'Not Found');
        return;
      }
      const object = repo.objects.get(sha);
      if (!object || object.type !== 'commit') {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { sha, commit: { message: commitMessage(repo, sha) } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Git data: refs.
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2 && method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const ref = input.ref;
      const sha = input.sha;
      if (typeof ref !== 'string' || typeof sha !== 'string' || !isObjectId(sha)) {
        sendError(res, 422, 'ref and sha are required');
        return;
      }
      if (repo.refs.has(ref)) {
        sendError(res, 422, 'Reference already exists');
        return;
      }
      const object = repo.objects.get(sha);
      if (!object) {
        sendError(res, 422, 'Object does not exist');
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, 201, { ref, object: { sha } });
      return;
    }
    if (tail.length >= 3 && method === 'GET') {
      const ref = `refs/${tail.slice(2).join('/')}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, { ref, object: { sha } });
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Contents.
  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    await handleContents(repo, req, res, method, url, path);
    return;
  }

  // Labels.
  if (tail[0] === 'labels') {
    if (method === 'POST' && tail.length === 1) {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const name = input.name;
      if (typeof name !== 'string' || name === '') {
        sendError(res, 422, 'name is required');
        return;
      }
      const existing = repo.labels.find((label) => label.name === name);
      if (existing) {
        sendJson(res, 200, { id: existing.id, name: existing.name, color: existing.color, description: existing.description });
        return;
      }
      const label = {
        id: storeLabelId(repo),
        name,
        color: typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed',
        description: typeof input.description === 'string' ? input.description : '',
      };
      repo.labels.push(label);
      sendJson(res, 201, { id: label.id, name: label.name, color: label.color, description: label.description });
      return;
    }
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, repo.labels.map((label) => ({ id: label.id, name: label.name, color: label.color, description: label.description })));
      return;
    }
    sendError(res, 404, 'Not Found');
    return;
  }

  // Issues.
  if (tail[0] === 'issues') {
    await handleIssues(store, repo, req, res, method, url, tail.slice(1));
    return;
  }

  // Pulls.
  if (tail[0] === 'pulls') {
    await handlePulls(store, repo, req, res, method, url, tail.slice(1));
    return;
  }

  sendError(res, 404, 'Not Found');
}

function storeLabelId(repo: Repo): number {
  const max = repo.labels.reduce((acc, label) => Math.max(acc, label.id), 0);
  return max + 1;
}

function commitMessage(repo: Repo, sha: string): string {
  const object = repo.objects.get(sha);
  if (!object || object.type !== 'commit') return '';
  const text = object.data.toString('utf8');
  const blank = text.indexOf('\n\n');
  return blank >= 0 ? text.slice(blank + 2) : text;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

async function handleContents(
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  path: string,
): Promise<void> {
  const refParam = url.searchParams.get('ref');
  const ref = refParam ? `refs/heads/${refParam}` : `refs/heads/${repo.defaultBranch}`;

  if (method === 'GET') {
    const tree = refTree(repo, ref);
    if (tree === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    const flat = flattenTree(repo, tree);
    const entry = flat.get(path);
    if (entry) {
      const blob = repo.objects.get(entry.oid);
      if (!blob) {
        sendError(res, 404, 'Not Found');
        return;
      }
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: blob.data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: blob.data.toString('base64'),
        sha: entry.oid,
      });
      return;
    }
    // Directory listing: entries directly under `path` (or the root).
    const prefix = path === '' ? '' : `${path}/`;
    const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [filePath, fileEntry] of flat) {
      if (!filePath.startsWith(prefix)) continue;
      const rest = filePath.slice(prefix.length);
      const first = rest.split('/')[0]!;
      if (rest.includes('/')) {
        children.set(first, { type: 'dir', name: first, path: prefix + first, sha: '' });
      } else {
        children.set(first, { type: 'file', name: first, path: filePath, sha: fileEntry.oid });
      }
    }
    if (children.size === 0) {
      sendError(res, 404, 'Not Found');
      return;
    }
    sendJson(res, 200, [...children.values()].sort((a, b) => a.name.localeCompare(b.name)));
    return;
  }

  if (method === 'PUT') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON');
      return;
    }
    const input = (parsed.value ?? {}) as Record<string, unknown>;
    const contentB64 = input.content;
    const message = typeof input.message === 'string' ? input.message : 'Update file';
    if (typeof contentB64 !== 'string') {
      sendError(res, 422, 'content is required');
      return;
    }
    let content: Buffer;
    try {
      content = Buffer.from(contentB64, 'base64');
    } catch {
      sendError(res, 422, 'content must be base64');
      return;
    }
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const targetRef = `refs/heads/${branch}`;
    const existingSha = blobShaOf(repo, path, targetRef);
    const isCreate = existingSha === null;
    if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== existingSha) {
      sendError(res, 409, 'sha does not match');
      return;
    }
    try {
      const { commitSha, blobSha } = commitFile(repo, targetRef, path, content, message);
      sendJson(res, isCreate ? 201 : 200, {
        content: { name: path.split('/').pop() ?? path, path, sha: blobSha, size: content.length, encoding: 'base64' },
        commit: { sha: commitSha, message },
      });
    } catch (err) {
      sendError(res, 422, err instanceof Error ? err.message : 'cannot commit');
    }
    return;
  }

  if (method === 'DELETE') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON');
      return;
    }
    const input = (parsed.value ?? {}) as Record<string, unknown>;
    const message = typeof input.message === 'string' ? input.message : 'Delete file';
    const branch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : repo.defaultBranch;
    const targetRef = `refs/heads/${branch}`;
    const existingSha = blobShaOf(repo, path, targetRef);
    if (existingSha === null) {
      sendError(res, 404, 'Not Found');
      return;
    }
    if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== existingSha) {
      sendError(res, 409, 'sha does not match');
      return;
    }
    try {
      const commitSha = deleteFile(repo, targetRef, path, message);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
    } catch (err) {
      sendError(res, 422, err instanceof Error ? err.message : 'cannot delete');
    }
    return;
  }

  sendError(res, 405, 'method not allowed');
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

async function handleIssues(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  tail: string[],
): Promise<void> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const title = input.title;
      if (typeof title !== 'string' || title === '') {
        sendError(res, 422, 'title is required');
        return;
      }
      const labelNames = Array.isArray(input.labels) ? input.labels.filter((x): x is string => typeof x === 'string') : [];
      try {
        const issue = createIssue(store, repo, title, typeof input.body === 'string' ? input.body : '', labelNames);
        sendJson(res, 201, issuePayload(repo, issue));
      } catch (err) {
        sendError(res, 422, err instanceof Error ? err.message : 'cannot create issue');
      }
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const sort = url.searchParams.get('sort') ?? 'created';
      const direction = url.searchParams.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()].filter((issue) => !issue.isPull);
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => {
        const cmp = sort === 'created' ? a.number - b.number : a.number - b.number;
        return direction === 'asc' ? cmp : -cmp;
      });
      const { page, perPage } = pageParams(url);
      const { pageItems, hasNext } = paginate(issues, page, perPage);
      const link = linkHeader(req, url, page, perPage, hasNext);
      sendJson(res, 200, pageItems.map((issue) => issuePayload(repo, issue)), link ? { link } : {});
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isFinite(number)) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const issue = repo.issues.get(number);
  if (!issue || issue.isPull) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, issuePayload(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      if (typeof input.title === 'string') issue.title = input.title;
      if (typeof input.body === 'string') issue.body = input.body;
      if (input.state === 'open' || input.state === 'closed') {
        issue.state = input.state;
        issue.closedAt = input.state === 'closed' ? trialNowIso() : null;
      }
      issue.updatedAt = trialNowIso();
      sendJson(res, 200, issuePayload(repo, issue));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  if (tail.length === 2 && tail[1] === 'comments') {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const commentBody = typeof input.body === 'string' ? input.body : '';
      const now = trialNowIso();
      const comment = { id: repo.nextCommentId++, body: commentBody, createdAt: now, updatedAt: now };
      const list = repo.comments.get(number) ?? [];
      list.push(comment);
      repo.comments.set(number, list);
      sendJson(res, 201, { id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
      return;
    }
    if (method === 'GET') {
      const comments = repo.comments.get(number) ?? [];
      sendJson(res, 200, comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: comment.createdAt, updated_at: comment.updatedAt, user: { login: VIEWER_LOGIN, id: VIEWER_ID } })));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  sendError(res, 404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

async function handlePulls(
  store: Store,
  repo: Repo,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
  tail: string[],
): Promise<void> {
  if (tail.length === 0) {
    if (method === 'POST') {
      const body = await readBody(req);
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendError(res, 400, 'malformed JSON');
        return;
      }
      const input = (parsed.value ?? {}) as Record<string, unknown>;
      const title = input.title;
      const head = input.head;
      const base = input.base;
      if (typeof title !== 'string' || title === '' || typeof head !== 'string' || typeof base !== 'string') {
        sendError(res, 422, 'title, head and base are required');
        return;
      }
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) {
        sendError(res, 422, 'A pull request already exists for these branches');
        return;
      }
      try {
        const pull = createPull(store, repo, title, typeof input.body === 'string' ? input.body : '', head, base);
        sendJson(res, 201, pullPayload(repo, pull));
      } catch (err) {
        sendError(res, 422, err instanceof Error ? err.message : 'cannot create pull request');
      }
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const { page, perPage } = pageParams(url);
      const { pageItems, hasNext } = paginate(pulls, page, perPage);
      const link = linkHeader(req, url, page, perPage, hasNext);
      sendJson(res, 200, pageItems.map((pull) => pullPayload(repo, pull)), link ? { link } : {});
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  const number = Number.parseInt(tail[0] ?? '', 10);
  if (!Number.isFinite(number)) {
    sendError(res, 404, 'Not Found');
    return;
  }
  const pull = repo.pulls.get(number);
  if (!pull) {
    sendError(res, 404, 'Not Found');
    return;
  }

  if (tail.length === 1) {
    if (method === 'GET') {
      sendJson(res, 200, pullPayload(repo, pull));
      return;
    }
    sendError(res, 405, 'method not allowed');
    return;
  }

  if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
    const files = pullFiles(repo, pull);
    sendJson(res, 200, files.map((file) => ({
      filename: file.filename,
      status: file.status === 'modified' ? 'modified' : file.status === 'added' ? 'added' : 'removed',
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })));
    return;
  }

  if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
    const body = await readBody(req);
    const parsed = parseJsonBody(body);
    if (!parsed.ok) {
      sendError(res, 400, 'malformed JSON');
      return;
    }
    const input = (parsed.value ?? {}) as Record<string, unknown>;
    if (pull.state !== 'open') {
      sendError(res, 405, 'Pull request is not open');
      return;
    }
    if (pullConflicts(repo, pull)) {
      sendError(res, 405, 'Merge conflict');
      return;
    }
    const methodName = typeof input.merge_method === 'string' ? input.merge_method : 'squash';
    const sha = mergePull(repo, pull, methodName === 'merge' ? 'merge' : 'squash');
    sendJson(res, 200, { sha, merged: true, message: `Pull request successfully merged` });
    return;
  }

  sendError(res, 404, 'Not Found');
}
