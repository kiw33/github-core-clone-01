// mcp.ts — the MCP endpoint (Streamable HTTP, JSON-RPC 2.0) that gh's
// github-mcp-server talks to, plus the legacy initialize handshake and the
// server/discover probe the harness sends first.
//
// Tool results are always
//   { content: [{ type: "text", text: JSON.stringify(payload) }],
//     structuredContent: payload }
// so both the text scan and the structured read agree. The tool list is a
// single constant: two tools/list calls return the identical array.

import {
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  mergePull,
  pullConflicts,
  VIEWER_LOGIN,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/** The one canonical tool list. Do not build it per-request. */
export const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        full_name: { type: 'string', description: 'Full repository name owner/repo' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'list_repos',
    description: 'List repositories owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get a single issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        issue_number: { type: 'number', description: 'Issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
        body: { type: 'string', description: 'Pull request body' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge an open pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// shared shapes
// ---------------------------------------------------------------------------

function repoPayload(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? 1000 : 0 },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
  };
}

function issuePayload(repo: Repo, issue: { number: number; title: string; body: string; state: string; labels: Array<{ name: string; color: string }> }): Record<string, unknown> {
  return {
    id: issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullPayload(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function toolResult(payload: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

/** Accept `owner`/`repo` or a `full_name` "owner/repo"; also accept synonyms. */
function splitOwnerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = args.owner;
  let repo = args.repo;
  if (typeof args.full_name === 'string' && args.full_name.includes('/')) {
    const [o, r] = args.full_name.split('/', 2);
    if (owner === undefined) owner = o;
    if (repo === undefined) repo = r;
  }
  if (typeof args.repository === 'string' && args.repository.includes('/')) {
    const [o, r] = args.repository.split('/', 2);
    if (owner === undefined) owner = o;
    if (repo === undefined) repo = r;
  }
  if (typeof owner !== 'string' || owner === '') return null;
  if (typeof repo !== 'string' || repo === '') return null;
  return { owner, repo };
}

function missingRequired(tool: ToolDef, args: Record<string, unknown>): string | null {
  for (const name of tool.inputSchema.required) {
    if (args[name] === undefined || args[name] === null || args[name] === '') return name;
  }
  return null;
}

// ---------------------------------------------------------------------------
// tool dispatch
// ---------------------------------------------------------------------------

export function callTool(store: Store, name: string, rawArgs: unknown): Record<string, unknown> {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (!tool) {
    return toolError(`unknown tool: ${name}`);
  }
  const args: Record<string, unknown> =
    rawArgs !== null && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  // Synonyms the suite may use.
  if (args.number !== undefined && args.pull_number === undefined) args.pull_number = args.number;
  if (args.issueNumber !== undefined && args.issue_number === undefined) args.issue_number = args.issueNumber;

  if (name === 'create_repo') {
    const missing = missingRequired(tool, args);
    if (missing) return toolError(`missing required argument: ${missing}`);
    const repoName = String(args.name);
    if (store.getRepo(VIEWER_LOGIN, repoName)) {
      return toolError(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
    }
    const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
    return toolResult(repoPayload(repo));
  }

  if (name === 'list_repos') {
    return toolResult(store.viewerRepos().map((repo) => repoPayload(repo)));
  }

  const target = splitOwnerRepo(args);
  if (!target && name !== 'create_repo') {
    return toolError('missing required arguments: owner and repo');
  }
  const repo = target ? store.getRepo(target.owner, target.repo) : undefined;
  if (!repo && name !== 'create_repo') {
    return toolError(`Repository ${target?.owner}/${target?.repo} not found`);
  }
  const repoValue = repo as Repo;

  switch (name) {
    case 'get_repo':
      return toolResult(repoPayload(repoValue));
    case 'create_issue': {
      const missing = missingRequired(tool, args);
      if (missing) return toolError(`missing required argument: ${missing}`);
      const issue = storeCreateIssue(
        store,
        repoValue,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        [],
      );
      return toolResult(issuePayload(repoValue, issue));
    }
    case 'get_issue': {
      const missing = missingRequired(tool, args);
      if (missing) return toolError(`missing required argument: ${missing}`);
      const issue = repoValue.issues.get(Number(args.issue_number));
      if (!issue) return toolError(`Issue ${String(args.issue_number)} not found`);
      return toolResult(issuePayload(repoValue, issue));
    }
    case 'list_issues': {
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repoValue.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.number - a.number);
      return toolResult(issues.map((issue) => issuePayload(repoValue, issue)));
    }
    case 'create_pull_request': {
      const missing = missingRequired(tool, args);
      if (missing) return toolError(`missing required argument: ${missing}`);
      try {
        const pull = storeCreatePull(
          store,
          repoValue,
          String(args.title),
          typeof args.body === 'string' ? args.body : '',
          String(args.head),
          String(args.base),
        );
        return toolResult(pullPayload(repoValue, pull));
      } catch (err) {
        return toolError(err instanceof Error ? err.message : String(err));
      }
    }
    case 'merge_pull_request': {
      const missing = missingRequired(tool, args);
      if (missing) return toolError(`missing required argument: ${missing}`);
      const pull = repoValue.pulls.get(Number(args.pull_number));
      if (!pull) return toolError(`Pull request ${String(args.pull_number)} not found`);
      if (pull.state !== 'open') return toolError('Pull request is not open');
      if (pullConflicts(repoValue, pull)) return toolError('merge conflict');
      const sha = mergePull(repoValue, pull, 'squash');
      return toolResult({ ...pullPayload(repoValue, pull), sha, merged: true });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC framing
// ---------------------------------------------------------------------------

export interface RpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown> | unknown[];
}

export function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

export function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** Handle one decoded JSON-RPC request. Returns null for notifications. */
export function handleRpc(store: Store, request: RpcRequest): Record<string, unknown> | null {
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return null;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: 'forge', version: '1.0.0' };
    return rpcResult(id, {
      supportedVersions: [MCP_PROTOCOL_VERSION, '2025-06-18', '2025-03-26'],
      capabilities: { tools: {} },
      serverInfo,
      _meta: { serverInfo },
    });
  }

  if (method === 'initialize') {
    return rpcResult(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: '1.0.0' },
    });
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    // The constant array, so repeated calls are byte-identical.
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const toolName = params.name as string | undefined;
    const args = params.arguments ?? {};
    if (typeof toolName !== 'string' || toolName === '') {
      return rpcError(id, -32602, 'missing tool name');
    }
    const result = callTool(store, toolName, args);
    if ((result as { isError?: boolean }).isError === true) {
      // Unknown tool is a protocol-level error; a failed call is a tool error.
      if (toolName !== undefined && !TOOLS.some((entry) => entry.name === toolName)) {
        return rpcError(id, -32602, `unknown tool: ${toolName}`);
      }
    }
    return rpcResult(id, result);
  }

  return rpcError(id, -32601, `method not found: ${method}`);
}

/** Parse a raw MCP request body. Returns the envelope to send, or null. */
export function handleMcpBody(store: Store, body: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return rpcError(null, -32700, 'Parse error');
  }
  if (parsed === null || typeof parsed !== 'object') {
    return rpcError(null, -32700, 'Parse error');
  }
  if (Array.isArray(parsed)) {
    // Batch of requests: answer each, in order.
    const results = parsed
      .map((entry) => handleRpc(store, entry as RpcRequest))
      .filter((entry) => entry !== null);
    return { __batch: results } as unknown as Record<string, unknown>;
  }
  return handleRpc(store, parsed as RpcRequest);
}
