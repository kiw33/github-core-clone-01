// git.ts — the git object model, packfiles, pkt-lines and the smart-HTTP
// protocol (upload-pack v2 / v0, receive-pack v0), implemented on the Node
// standard library only. No git binary, no outside service.
//
// Wire notes (from the suite's own client, which is the only client):
// - info/refs for upload-pack with `Git-Protocol: version=2` answers a v2
//   capability advertisement; without it, a v0 ref advertisement.
// - v2 fetch answers sections: acknowledgments, shallow-info, packfile.
//   The packfile section is sideband-framed (band 1 = pack bytes).
// - v0 fetch answers NAK/ACK lines, then the same sideband pack.
// - receive-pack is v0 only and answers report-status inside band 1.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

export function putObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------------------
// trees and commits
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree entry is truncated');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  tree: string;
  parents?: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents ?? []) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${fields.message}`, 'utf8');
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space >= 0) headers.set(line.slice(0, space), line.slice(space + 1));
  }
  return {
    object: headers.get('object') ?? '',
    type: (headers.get('type') ?? 'commit') as GitObjectType,
    tag: headers.get('tag') ?? '',
    tagger: headers.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

/** Peel a tag (possibly through nested tags) to the commit it names. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const object = objects.get(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** Every object reachable from `roots` (commits, trees, tags; gitlinks skipped). */
export function collectReachable(
  roots: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(
  objects: Map<string, GitObject>,
  ancestor: string,
  descendant: string,
): boolean {
  if (ancestor === descendant) return true;
  const ancCommit = peelToCommit(objects, ancestor);
  const descCommit = peelToCommit(objects, descendant);
  if (ancCommit === null || descCommit === null) return false;
  if (ancCommit === descCommit) return true;
  const seen = new Set<string>();
  const queue = [descCommit];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancCommit) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** The best common ancestor of two commits (first common commit found walking both histories). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const aCommit = peelToCommit(objects, a);
  const bCommit = peelToCommit(objects, b);
  if (aCommit === null || bCommit === null) return null;
  const aAncestors = new Set<string>();
  const queueA = [aCommit];
  while (queueA.length > 0) {
    const oid = queueA.pop()!;
    if (aAncestors.has(oid)) continue;
    aAncestors.add(oid);
    const object = objects.get(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueA.push(p);
  }
  const queueB = [bCommit];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const oid = queueB.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (aAncestors.has(oid)) return oid;
    const object = objects.get(oid);
    if (object?.type === 'commit') for (const p of parseCommit(object.data).parents) queueB.push(p);
  }
  return null;
}

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

const PKT_LINE_MAX = 65520;

export function encodePktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function encodePktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

export type PktPacket = { kind: 'flush' } | { kind: 'delim' } | { kind: 'data'; payload: Buffer; raw: Buffer };

/** Decode a whole buffer of pkt-lines; `allowTrailing` leaves raw bytes (a pack) unconsumed. */
export function decodePktLines(
  bytes: Buffer,
  options: { allowTrailing?: boolean } = {},
): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) break;
    const header = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) {
      if (options.allowTrailing) break;
      throw new Error(`invalid pkt-line length ${JSON.stringify(header)}`);
    }
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      offset += 4;
      continue; // response-end: skip
    }
    if (length < 4 || length > PKT_LINE_MAX || offset + length > bytes.length) {
      if (options.allowTrailing) break;
      throw new Error('truncated or oversized pkt-line');
    }
    const raw = bytes.subarray(offset, offset + length);
    packets.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets, rest: bytes.subarray(offset) };
}

// ---------------------------------------------------------------------------
// packfiles (plain objects only; no deltas are ever written)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    // Fastest compression: pack bytes are inflated by the client either
    // way, and the clone workload builds 50 packs of ~600 objects each.
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/** Read a packfile and resolve every object, including OFS/REF deltas. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack does not start with PACK');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _resolved?: { type: GitObjectType; data: Buffer; oid: string } })._resolved;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error('ref-delta base is neither in the pack nor held');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const out = { type, data, oid };
    (entry as unknown as { _resolved?: unknown })._resolved = out;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return out;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------------------
// the smart-HTTP surface over one repository's refs and objects
// ---------------------------------------------------------------------------

export interface RepoLike {
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  defaultBranch: string;
}

const V2_CAPABILITIES: readonly string[] = [
  'version 2',
  'ls-refs=unborn',
  'fetch=shallow wait-for-done',
  'object-format=sha1',
  'agent=forge/1.0',
];

function sortedRefs(repo: RepoLike): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = 'symref=HEAD:refs/heads/main agent=forge/1.0';
  if (service === 'git-upload-pack') return `side-band-64k shallow ofs-delta thin-pack multi_ack ${common}`;
  return `report-status side-band-64k delete-refs ofs-delta ${common}`;
}

/** The v2 capability advertisement (info/refs with Git-Protocol: version=2). */
export function advertiseV2(): Buffer {
  const items: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush'];
  for (const line of V2_CAPABILITIES) items.push(`${line}\n`);
  items.push('flush');
  return encodePktLines(items as readonly (string | 'flush')[]);
}

/** The v0 ref advertisement for either service. */
export function advertiseV0(repo: RepoLike, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const preamble = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const parts: Buffer[] = [encodePktLine(preamble), pktFlush()];
  const caps = v0Capabilities(service);
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs[0]!.oid;
    parts.push(encodePktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(encodePktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith('refs/tags/')) {
        const object = repo.objects.get(ref.oid);
        if (object?.type === 'tag') {
          const peeled = peelToCommit(repo.objects, ref.oid);
          if (peeled !== null) parts.push(encodePktLine(`${peeled} ${ref.name}^{}\n`));
        }
      }
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

export interface LsRefsArgs {
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

/** Parse a v2 ls-refs request body into its arguments. */
export function parseLsRefsArgs(body: Buffer): LsRefsArgs {
  const { packets } = decodePktLines(body);
  const args: LsRefsArgs = { prefixes: [], peel: false, symrefs: false, unborn: false };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

/** Answer a v2 ls-refs request. */
export function lsRefsResponse(repo: RepoLike, args: LsRefsArgs): Buffer {
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((p) => name.startsWith(p));
  if (headOid === undefined) {
    if (keep('HEAD')) lines.push(`unborn HEAD symref-target:${headRef}\n`);
  } else {
    if (keep('HEAD')) lines.push(`${headOid} HEAD symref-target:${headRef}\n`);
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name.startsWith('refs/tags/') && args.peel) {
      const object = repo.objects.get(ref.oid);
      if (object?.type === 'tag') {
        const peeled = peelToCommit(repo.objects, ref.oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines as readonly (string | 'flush')[]);
}

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

/** Parse a v2 fetch request body. */
export function parseFetchArgs(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !seenDelim) continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

/** Parse a v0 upload-pack request body (wants, haves, shallow, deepen). */
export function parseFetchArgsV0(body: Buffer): FetchArgs {
  const { packets } = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n)) args.depth = n;
    }
  }
  return args;
}

export interface SendSet {
  objects: GitObject[];
  shallowOut: string[];
  unshallowOut: string[];
}

/**
 * The objects a fetch must send, honouring haves, shallow boundaries and
 * depth. Commit traversal stops at a have that is not a shallow boundary
 * (the client already holds it and its history); a shallow boundary's
 * parents are exactly what a deepen asks for.
 */
export function computeSendSet(repo: RepoLike, args: FetchArgs): SendSet {
  const shallowSet = new Set(args.shallow);
  const haveSet = new Set(args.haves);
  const depth = args.depth;
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  const visit = (oid: string, dist: number): void => {
    const object = repo.objects.get(oid);
    if (!object) return;
    if (object.type === 'tag') {
      // A wanted tag travels with its target commit at the same depth.
      includedCommits.add(oid);
      visit(parseTag(object.data).object, dist);
      return;
    }
    if (object.type !== 'commit') return;
    if (depth !== null && dist >= depth) {
      boundary.add(oid);
      return;
    }
    if (haveSet.has(oid) && !shallowSet.has(oid)) return;
    if (includedCommits.has(oid)) return;
    includedCommits.add(oid);
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) visit(parent, dist + 1);
  };
  for (const want of args.wants) {
    const object = repo.objects.get(want);
    if (!object) continue;
    if (object.type === 'commit' || object.type === 'tag') visit(want, 0);
    else includedCommits.add(want);
  }
  // Trees and blobs of every included commit, plus the wanted objects themselves.
  // (A tag contributes only itself and its target commit's tree closure —
  // never the target's ancestors, which the depth walk already decided.)
  const send = new Set<string>();
  for (const oid of includedCommits) {
    const object = repo.objects.get(oid);
    if (!object) continue;
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      for (const reached of collectReachable([commit.tree], (id) => repo.objects.get(id))) send.add(reached);
      send.add(oid);
    } else if (object.type === 'tag') {
      send.add(oid);
      const target = peelToCommit(repo.objects, oid);
      if (target !== null && includedCommits.has(target)) {
        const targetObject = repo.objects.get(target);
        if (targetObject?.type === 'commit') {
          const commit = parseCommit(targetObject.data);
          for (const reached of collectReachable([commit.tree], (id) => repo.objects.get(id))) send.add(reached);
        }
      }
    } else {
      send.add(oid);
    }
  }
  // Never re-send what the client holds (unless it is a shallow boundary being deepened).
  const haveReachable = new Set<string>();
  for (const have of args.haves) {
    if (shallowSet.has(have)) continue;
    for (const reached of collectReachable([have], (id) => repo.objects.get(id))) haveReachable.add(reached);
  }
  for (const oid of haveReachable) {
    if (!includedCommits.has(oid)) send.delete(oid);
  }
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }
  // Shallow-info: the deepest included commits when a depth was asked for.
  const shallowOut: string[] = [];
  if (depth !== null) {
    // Recompute distances to find the boundary commits.
    const distOf = new Map<string, number>();
    const walk = (oid: string, dist: number): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') return;
      if (distOf.has(oid) && distOf.get(oid)! <= dist) return;
      distOf.set(oid, dist);
      for (const parent of parseCommit(object.data).parents) walk(parent, dist + 1);
    };
    for (const want of args.wants) {
      const target = peelToCommit(repo.objects, want) ?? want;
      walk(target, 0);
    }
    for (const oid of includedCommits) {
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      if (distOf.get(oid) === depth - 1) shallowOut.push(oid);
    }
    for (const oid of boundary) if (!shallowOut.includes(oid)) shallowOut.push(oid);
  }
  const unshallowOut: string[] = [];
  for (const old of args.shallow) {
    if (includedCommits.has(old)) {
      // Its parent is now included (or it is itself beyond the old boundary).
      const object = repo.objects.get(old);
      if (object?.type === 'commit') {
        const parents = parseCommit(object.data).parents;
        if (parents.some((p) => includedCommits.has(p)) || depth === null) unshallowOut.push(old);
      }
    }
  }
  return { objects, shallowOut, unshallowOut };
}

/** Frame pack bytes as sideband band-1 pkt-lines (each at most 65515 data bytes). */
export function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(encodePktLine(framed));
  }
  if (pack.length === 0) {
    // An empty pack still needs one band-1 packet so the section is non-empty.
    parts.push(encodePktLine(Buffer.from([1])));
  }
  return Buffer.concat(parts);
}

/** Answer a v2 fetch request. */
export function fetchV2Response(repo: RepoLike, args: FetchArgs): Buffer {
  const send = computeSendSet(repo, args);
  const pack = writePack(send.objects);
  const parts: Buffer[] = [];
  parts.push(encodePktLine('acknowledgments\n'));
  parts.push(encodePktLine('NAK\n'));
  parts.push(pktFlush());
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of send.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of send.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktFlush());
  }
  parts.push(encodePktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Answer a v0 fetch request. */
export function fetchV0Response(repo: RepoLike, args: FetchArgs): Buffer {
  const send = computeSendSet(repo, args);
  const pack = writePack(send.objects);
  const parts: Buffer[] = [encodePktLine('NAK\n')];
  for (const oid of send.shallowOut) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of send.unshallowOut) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/** Parse a receive-pack body into commands plus the pack that follows them. */
export function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { packets, rest } = decodePktLines(body, { allowTrailing: true });
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  return { commands, pack: rest };
}

/**
 * Apply one receive-pack exchange: unpack the pack into the repo, validate
 * every command (fast-forward only), move the accepted refs, and build the
 * sideband report-status body.
 */
export function receivePackResponse(repo: RepoLike, body: Buffer): Buffer {
  const lines: PushReportLine[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  let commands: PushCommand[] = [];
  let packObjects = new Map<string, GitObject>();
  try {
    const parsed = parseReceivePack(body);
    commands = parsed.commands;
    if (parsed.pack.length > 0) {
      packObjects = readPack(parsed.pack, (oid) => repo.objects.get(oid));
      for (const [oid, object] of packObjects) {
        if (hashObject(object.type, object.data) !== oid) throw new Error('pack object hash mismatch');
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : 'unpack error';
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          lines.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          lines.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        lines.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        lines.push({ ref: command.ref, ok: true, reason: '' });
        continue;
      }
      if (command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!isAncestor(repo.objects, current, command.newOid)) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  const reportLines: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const line of lines) {
    reportLines.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  const report = encodePktLines(reportLines as readonly (string | 'flush')[]);
  // The report travels inside sideband band 1; split it into pkt-lines of band data.
  const parts: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < report.length; offset += CHUNK) {
    const slice = report.subarray(offset, Math.min(report.length, offset + CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}
