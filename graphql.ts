// graphql.ts — a small GraphQL executor for exactly the documents gh and
// github-mcp-server send: repository/issue/pull-request reads, the
// create/close/merge mutations, __type introspection, node(id:) and
// operation batching. It is a parser + resolver, not a generic GraphQL
// server: unknown fields answer HTTP 200 with an `errors` array naming
// them, exactly as the suite requires.

import {
  createIssue as storeCreateIssue,
  createPull as storeCreatePull,
  decodeGlobalId,
  globalId,
  mergePull,
  pullConflicts,
  pullFiles,
  trialNowIso,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------------------
// parser (subset: operations, fields, aliases, arguments, inline fragments)
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; value: Value[] }
  | { kind: 'object'; value: Array<[string, Value]> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<[string, Value]>;
  selections: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: SelectionNode[];
}

const NAME_RE = /^[_A-Za-z][_0-9A-Za-z]*/;

function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():=[]!@'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += input[j]!;
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (ch === '$') {
      const match = NAME_RE.exec(input.slice(i + 1));
      if (!match) throw new Error('bad variable');
      tokens.push(`$${match[0]}`);
      i += 1 + match[0].length;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(input.slice(i));
      if (!match) throw new Error('bad number');
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    const match = NAME_RE.exec(input.slice(i));
    if (match) {
      tokens.push(match[0]);
      i += match[0].length;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | null {
    return this.tokens[this.pos] ?? null;
  }

  next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of document');
    this.pos += 1;
    return token;
  }

  expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek() !== null) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      type = this.next() as 'query' | 'mutation';
      const next = this.peek();
      if (next !== null && next !== '{' && next !== '(') name = this.next();
    }
    if (this.peek() === '(') this.parseVariableDefinitions();
    const selections = this.parseSelectionSet();
    return { type, name, selections };
  }

  parseVariableDefinitions(): void {
    this.expect('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      else if (token === ')' || token === ']' || token === '}') depth -= 1;
    }
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === null) throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
    }
    const first = this.next();
    let alias: string | null = null;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      alias = first;
      name = this.next();
    }
    const args: Array<[string, Value]> = [];
    if (this.peek() === '(') {
      this.expect('(');
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push([argName, this.parseValue()]);
      }
      this.expect(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  parseValue(): Value {
    const token = this.next();
    if (token.startsWith('$')) return { kind: 'variable', name: token.slice(1) };
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d*\.\d+/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', value: values };
    }
    if (token === '{') {
      const entries: Array<[string, Value]> = [];
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        entries.push([key, this.parseValue()]);
      }
      this.expect('}');
      return { kind: 'object', value: entries };
    }
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.value.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of value.value) out[key] = resolveValue(entry, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema: the fields each type answers
// ---------------------------------------------------------------------------

const FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema', 'search'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url', 'databaseId'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'defaultBranchRef',
    'viewerPermission', 'hasIssuesEnabled', 'url', 'createdAt', 'updatedAt', 'isPrivate',
    'issue', 'issues', 'pullRequest', 'pullRequests', 'labels',
  ],
  Ref: ['name', 'target'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  IssueConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  IssueEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergedAt', 'createdAt', 'updatedAt', 'url', 'author', 'files',
  ],
  PullRequestConnection: ['nodes', 'edges', 'totalCount', 'pageInfo'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFileConnection: ['nodes', 'totalCount', 'pageInfo'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'totalCount'],
  CommentConnection: ['nodes', 'totalCount', 'pageInfo'],
  Comment: ['id', 'body', 'createdAt', 'updatedAt', 'author'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
  __Schema: ['queryType', 'types'],
};

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'closedAt'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'files', 'headRefName', 'baseRefName',
    'headRefOid', 'baseRefOid', 'mergedAt', 'createdAt', 'updatedAt', 'url', 'author', 'isDraft',
  ],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url',
    'createdAt', 'updatedAt', 'isPrivate', 'labels', 'diskUsage', 'forkCount', 'stargazerCount',
  ],
  SearchType: [],
};

const SEARCH_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'MILESTONE', 'WIKI'];

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

type AnyRecord = Record<string, unknown>;

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function viewerUser(): AnyRecord {
  return {
    __typename: 'User',
    login: VIEWER_LOGIN,
    id: String(VIEWER_ID),
    databaseId: VIEWER_ID,
    name: VIEWER_NAME,
    email: VIEWER_EMAIL,
    avatarUrl: '',
    url: `https://github.com/${VIEWER_LOGIN}`,
  };
}

function repoObject(repo: Repo): AnyRecord {
  return {
    __typename: 'Repository',
    _repo: repo,
    id: globalId('repo', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.private,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueObject(repo: Repo, issue: Issue): AnyRecord {
  return {
    __typename: 'Issue',
    _repo: repo,
    _issue: issue,
    id: globalId('issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullObject(repo: Repo, pull: Pull): AnyRecord {
  return {
    __typename: 'PullRequest',
    _repo: repo,
    _pull: pull,
    id: globalId('pr', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergedAt: pull.mergedAt,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

function sortIssues(issues: Issue[], orderBy: unknown): Issue[] {
  const list = [...issues];
  const order = (orderBy as { field?: string; direction?: string } | null) ?? null;
  const direction = order?.direction === 'ASC' ? 1 : -1;
  list.sort((a, b) => (a.number - b.number) * direction);
  return list;
}

function issuesConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): AnyRecord {
  const states = args.states as string[] | undefined;
  // Cursor semantics depend on order: with DESC, `after` means "before this
  // number"; with ASC it means "after this number".
  const sorted = sortIssues([...repo.issues.values()].filter((i) => !i.isPull), args.orderBy);
  const filteredByState = Array.isArray(states) && states.length > 0
    ? sorted.filter((issue) => new Set(states.map((s) => String(s).toLowerCase())).has(issue.state))
    : sorted;
  const after = cursorNumber(args.after);
  let rest = filteredByState;
  if (after !== null) {
    const direction = ((args.orderBy as { direction?: string } | undefined)?.direction ?? 'DESC') === 'ASC' ? 1 : -1;
    rest = filteredByState.filter((issue) => direction === 1 ? issue.number > after : issue.number < after);
  }
  void ctx;
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = rest.slice(0, first);
  const hasNextPage = rest.length > page.length;
  return {
    __typename: 'IssueConnection',
    nodes: page.map((issue) => issueObject(repo, issue)),
    edges: page.map((issue) => ({ __typename: 'IssueEdge', node: issueObject(repo, issue), cursor: cursorFor(issue.number) })),
    totalCount: rest.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

function pullsConnection(ctx: Ctx, repo: Repo, args: Record<string, unknown>): AnyRecord {
  let pulls = [...repo.pulls.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    pulls = pulls.filter((pull) => wanted.has(pull.state) || (pull.merged && wanted.has('closed')));
  } else {
    pulls = pulls.filter((pull) => pull.state === 'open');
  }
  pulls.sort((a, b) => b.number - a.number);
  const after = cursorNumber(args.after);
  if (after !== null) pulls = pulls.filter((pull) => pull.number < after);
  const first = typeof args.first === 'number' ? args.first : 30;
  const page = pulls.slice(0, first);
  return {
    __typename: 'PullRequestConnection',
    nodes: page.map((pull) => pullObject(repo, pull)),
    edges: page.map((pull) => ({ __typename: 'PullRequestEdge', node: pullObject(repo, pull), cursor: cursorFor(pull.number) })),
    totalCount: pulls.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: pulls.length > page.length,
      hasPreviousPage: after !== null,
      startCursor: page.length > 0 ? cursorFor(page[0]!.number) : null,
      endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
    },
  };
}

function resolveField(ctx: Ctx, typeName: string, parent: AnyRecord, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const [name, value] of field.args) args[name] = resolveValue(value, ctx.variables);
  const repo = parent._repo as Repo | undefined;

  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') return viewerUser();
      if (field.name === 'repository') {
        const owner = args.owner as string | undefined;
        const name = args.name as string | undefined;
        if (typeof owner !== 'string' || typeof name !== 'string') return null;
        const found = ctx.store.getRepo(owner, name);
        return found ? repoObject(found) : null;
      }
      if (field.name === 'node') {
        const id = args.id as string | undefined;
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'repo') {
          const found = ctx.store.findRepoById(Number(decoded.parts[0]));
          return found ? repoObject(found) : null;
        }
        if (decoded.kind === 'issue') {
          const found = ctx.store.findIssueByGlobalId(id);
          return found ? issueObject(found.repo, found.issue) : null;
        }
        if (decoded.kind === 'pr') {
          const found = ctx.store.findPullByGlobalId(id);
          return found ? pullObject(found.repo, found.pull) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = args.name as string | undefined;
        if (typeof name !== 'string') return null;
        if (name === 'SearchType') {
          return {
            __typename: '__Type',
            name: 'SearchType',
            kind: 'ENUM',
            fields: null,
            enumValues: SEARCH_ENUM.map((entry) => ({ __typename: '__EnumValue', name: entry, description: null })),
            description: null,
          };
        }
        const fields = TYPE_FIELDS[name];
        if (!fields) return null;
        return {
          __typename: '__Type',
          name,
          kind: 'OBJECT',
          fields: fields.map((entry) => ({ __typename: '__Field', name: entry, description: null })),
          enumValues: null,
          description: null,
        };
      }
      if (field.name === '__schema') {
        return { __typename: '__Schema', queryType: { name: 'Query' }, types: [] };
      }
      if (field.name === 'search') {
        return { __typename: 'SearchResultItemConnection', nodes: [], edges: [], totalCount: 0, pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null } };
      }
      return undefined;
    }
    case 'User': {
      if (field.name === 'id') return parent.id;
      return parent[field.name] ?? null;
    }
    case 'Repository': {
      if (!repo) return null;
      if (field.name === 'owner') return viewerUser();
      if (field.name === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return { __typename: 'Ref', name: repo.defaultBranch, target: { oid: tip } };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = args.number as number | undefined;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.get(number);
        return issue && !issue.isPull ? issueObject(repo, issue) : null;
      }
      if (field.name === 'issues') return issuesConnection(ctx, repo, args);
      if (field.name === 'pullRequest') {
        const number = args.number as number | undefined;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.get(number);
        return pull ? pullObject(repo, pull) : null;
      }
      if (field.name === 'pullRequests') return pullsConnection(ctx, repo, args);
      if (field.name === 'labels') {
        return {
          __typename: 'LabelConnection',
          nodes: repo.labels.map((label) => ({ __typename: 'Label', id: globalId('label', repo.id, label.id), name: label.name, color: label.color, description: label.description })),
          totalCount: repo.labels.length,
        };
      }
      if (field.name === 'id') return parent.id;
      if (field.name === 'databaseId') return parent.databaseId;
      return parent[field.name] ?? null;
    }
    case 'Ref': {
      return parent[field.name] ?? null;
    }
    case 'Issue': {
      const issue = parent._issue as Issue | undefined;
      if (!issue || !repo) return null;
      if (field.name === 'author') return viewerUser();
      if (field.name === 'labels') {
        return {
          __typename: 'LabelConnection',
          nodes: issue.labels.map((label) => ({ __typename: 'Label', id: globalId('label', repo.id, label.id), name: label.name, color: label.color, description: label.description })),
          totalCount: issue.labels.length,
        };
      }
      if (field.name === 'comments') {
        const comments = repo.comments.get(issue.number) ?? [];
        return {
          __typename: 'CommentConnection',
          nodes: comments.map((comment) => ({
            __typename: 'Comment',
            id: globalId('comment', repo.id, comment.id),
            body: comment.body,
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
          })),
          totalCount: comments.length,
          pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      return parent[field.name] ?? null;
    }
    case 'PullRequest': {
      const pull = parent._pull as Pull | undefined;
      if (!pull || !repo) return null;
      if (field.name === 'author') return viewerUser();
      if (field.name === 'mergeable') {
        if (pull.state !== 'open') return 'UNKNOWN';
        return pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field.name === 'files') {
        const files = pullFiles(repo, pull);
        const first = typeof args.first === 'number' ? args.first : 30;
        const page = files.slice(0, first);
        return {
          __typename: 'PullRequestFileConnection',
          nodes: page.map((file) => ({
            __typename: 'PullRequestFile',
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'REMOVED' : 'MODIFIED',
          })),
          totalCount: files.length,
          pageInfo: { hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
        };
      }
      return parent[field.name] ?? null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection':
    case 'LabelConnection':
    case 'CommentConnection': {
      return parent[field.name] ?? null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge': {
      return parent[field.name] ?? null;
    }
    case 'PageInfo':
    case 'Label':
    case 'Comment':
    case 'PullRequestFile':
    case '__Type':
    case '__Field':
    case '__EnumValue':
    case '__Schema': {
      return parent[field.name] ?? null;
    }
    default:
      return parent[field.name] ?? null;
  }
}

/** Execute one selection set against a typed value. */
function executeSelections(
  ctx: Ctx,
  typeName: string,
  parent: AnyRecord,
  selections: SelectionNode[],
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName) continue;
      const nested = executeSelections(ctx, typeName, parent, selection.selections);
      Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    const allowed = FIELDS[typeName];
    if (allowed !== undefined && !allowed.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[field.alias ?? field.name] = null;
      continue;
    }
    const value = resolveField(ctx, typeName, parent, field);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      out[field.alias ?? field.name] = null;
      continue;
    }
    out[field.alias ?? field.name] = resolveSubSelections(ctx, value, field.selections);
  }
  return out;
}

function resolveSubSelections(ctx: Ctx, value: unknown, selections: SelectionNode[] | null): unknown {
  if (selections === null || selections === undefined) return value;
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => resolveSubSelections(ctx, entry, selections));
  }
  if (typeof value === 'object') {
    const record = value as AnyRecord;
    const typeName = (record.__typename as string | undefined) ?? 'Unknown';
    return executeSelections(ctx, typeName, record, selections);
  }
  return value;
}

function executeMutation(ctx: Ctx, operation: Operation): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of operation.selections) {
    if (selection.kind !== 'field') continue;
    const field = selection.field;
    const args: Record<string, unknown> = {};
    for (const [name, value] of field.args) args[name] = resolveValue(value, ctx.variables);
    const input = (args.input ?? {}) as Record<string, unknown>;
    const key = field.alias ?? field.name;
    try {
      if (field.name === 'createIssue') {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'repo') throw new Error('repository not found');
        const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
        if (!repo) throw new Error('repository not found');
        const issue = storeCreateIssue(ctx.store, repo, String(input.title ?? ''), String(input.body ?? ''), []);
        out[key] = resolveSubSelections(ctx, { issue: issueObject(repo, issue) }, field.selections);
      } else if (field.name === 'closeIssue') {
        const found = ctx.store.findIssueByGlobalId(String(input.issueId ?? ''));
        if (!found) throw new Error('issue not found');
        found.issue.state = 'closed';
        found.issue.closedAt = trialNowIso();
        found.issue.updatedAt = trialNowIso();
        out[key] = resolveSubSelections(ctx, { issue: issueObject(found.repo, found.issue) }, field.selections);
      } else if (field.name === 'createPullRequest') {
        const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
        if (!decoded || decoded.kind !== 'repo') throw new Error('repository not found');
        const repo = ctx.store.findRepoById(Number(decoded.parts[0]));
        if (!repo) throw new Error('repository not found');
        const pull = storeCreatePull(
          ctx.store,
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        out[key] = resolveSubSelections(ctx, { pullRequest: pullObject(repo, pull) }, field.selections);
      } else if (field.name === 'mergePullRequest') {
        const found = ctx.store.findPullByGlobalId(String(input.pullRequestId ?? ''));
        if (!found) throw new Error('pull request not found');
        const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
        if (found.pull.state !== 'open') throw new Error('pull request is not open');
        if (pullConflicts(found.repo, found.pull)) throw new Error('merge conflict');
        mergePull(found.repo, found.pull, method === 'merge' ? 'merge' : 'squash');
        out[key] = resolveSubSelections(ctx, { pullRequest: pullObject(found.repo, found.pull) }, field.selections);
      } else if (field.name === 'addComment') {
        const found = ctx.store.findIssueByGlobalId(String(input.subjectId ?? ''));
        if (!found) throw new Error('issue not found');
        const now = trialNowIso();
        const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), createdAt: now, updatedAt: now };
        const list = found.repo.comments.get(found.issue.number) ?? [];
        list.push(comment);
        found.repo.comments.set(found.issue.number, list);
        const node = {
          __typename: 'Comment',
          id: globalId('comment', found.repo.id, comment.id),
          body: comment.body,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        };
        out[key] = resolveSubSelections(ctx, { commentEdge: { node } }, field.selections);
      } else {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
        out[key] = null;
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
    }
  }
  return out;
}

/** Execute one GraphQL operation document; returns the response envelope. */
export function executeGraphQL(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: Ctx = { store, variables, errors: [] };
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  const operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'empty document' }] };
  let data: unknown;
  if (operation.type === 'mutation') {
    data = executeMutation(ctx, operation);
  } else {
    data = executeSelections(ctx, 'Query', { __typename: 'Query' }, operation.selections);
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}
