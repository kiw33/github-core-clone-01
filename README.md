![make.fun](https://make.fun/badge/github-core-clone-01.svg)
![rank](https://make.fun/badge/github-core-clone-01/kiw33/github-core-clone-01/rank.svg)
![reward](https://make.fun/badge/github-core-clone-01/kiw33/github-core-clone-01/reward.svg)

# github-core-clone-01 — a GitHub-compatible git forge

Built for the [make.fun bounty](https://make.fun/bounty/github-core-clone-01): a
self-contained git forge that speaks the protocols real GitHub clients speak,
implemented in TypeScript on Node with **zero dependencies** and no git binary.

## What it serves

- **Git smart HTTP** (`/{owner}/{repo}.git`): protocol v2 and v0 `ls-refs` /
  `fetch` with shallow clones and deepen, `receive-pack` with fast-forward
  validation, packfiles with ofs/ref deltas, sideband progress.
- **REST v3** (`/api/v3`): repositories, contents (create/update/delete on any
  branch), branches, commits, Git Data refs, labels, issues, comments and
  pull requests with squash merge and conflict detection.
- **GraphQL** (`/api/graphql`): viewer, repository, issues, pull requests,
  `node(id:)`, the create/close/merge mutations, `__type` introspection and
  batched operation documents.
- **MCP** (`/mcp`): JSON-RPC 2.0 Streamable HTTP — `server/discover`,
  `initialize`, `tools/list` and `tools/call` for repo, issue and pull-request
  tools that act on the same store as REST and GraphQL.

All state is in memory and deterministic: timestamps come from
`MAKEFUN_TRIAL_NOW`, ids from counters, so a replayed trial sees the same
answers.

## Run

```sh
node --experimental-strip-types main.ts
```

The entrypoint listens on an ephemeral port, registers it at
`$MAKEFUN_ENV_URL/register`, answers `GET /healthz` with `{"ok": true}`, and
exits 0 once the harness reports `{"done": true}` at `$MAKEFUN_ENV_URL/done`.
`MAKEFUN_SHOP_TOKEN` is the bearer token every API call must carry.

## Tests

```sh
npm test
```

`tests/forge.test.ts` boots the server on a local port and exercises git
push/clone/fetch/shallow/non-fast-forward, the REST surface, GraphQL and MCP
over real HTTP.

## Layout

- `git.ts` — git object model, packfiles, pkt-lines, smart-HTTP protocol
- `store.ts` — in-memory repos, issues, pull requests, contents, merges
- `graphql.ts` — GraphQL parser and executor
- `mcp.ts` — MCP tool definitions and JSON-RPC handling
- `app.ts` — HTTP routing for REST, GraphQL, MCP and git
- `main.ts` — lifecycle: listen, register, wait for done, exit
