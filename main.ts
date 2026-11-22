// mend — one command that applies an AI-written edit to a tree of text files.
//
// The edit arrives as a patch in one of four shapes: a unified diff whose line
// numbers may be wrong, SEARCH/REPLACE blocks, a V4A patch, or JSON tool calls.
// This program reads the patch, finds what each edit names even when the
// model's whitespace drifted, and writes every change or none at all.
// SPEC.md is the contract; the code below is written from it directly.
//
// Node 22, standard library only. Usage: node main.ts [options] [PATCH]

import * as fs from 'node:fs';
import * as path from 'node:path';

const KNOWN_FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'] as const;

/** Stop the run with exit 2 and a single line of output. */
class Halt {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

/** One edit could not be applied: exit 1 with `error: <code> <path>`. */
class Slip {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function leading(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** A patch's lines: split on \n, strip one trailing \r each, drop the empty tail after a final \n. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const rows = text.split('\n');
  if (text.endsWith('\n')) rows.pop();
  return rows.map((r) => (r.endsWith('\r') ? r.slice(0, -1) : r));
}

function isSafe(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

function byteCmp(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** One file, seen as lines: its line break, its rows, whether it ends with a break. */
class Page {
  readonly eol: string;
  rows: string[];
  tail: boolean;

  constructor(eol: string, rows: string[], tail: boolean) {
    this.eol = eol;
    this.rows = rows;
    this.tail = tail;
  }

  static parse(text: string): Page {
    if (text === '') return new Page('\n', [], false);
    const nl = text.indexOf('\n');
    const eol = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
    const tail = text.endsWith(eol);
    const rows = text.split(eol);
    if (tail) rows.pop();
    return new Page(eol, rows, tail);
  }

  render(): string {
    if (this.rows.length === 0) return '';
    return this.rows.join(this.eol) + (this.tail ? this.eol : '');
  }
}

/**
 * The tree as the edits leave it. `orig` reads each file once from disk;
 * `pending` holds what the edits have done (null means deleted).
 */
class Vault {
  private seen = new Map<string, string | null>();
  private pending = new Map<string, string | null>();

  orig(p: string): string | null {
    if (!this.seen.has(p)) {
      let v: string | null = null;
      try {
        if (fs.statSync(p).isFile()) v = fs.readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.seen.set(p, v);
    }
    return this.seen.get(p) as string | null;
  }

  now(p: string): string | null {
    return this.pending.has(p) ? (this.pending.get(p) as string | null) : this.orig(p);
  }

  put(p: string, v: string | null): void {
    this.pending.set(p, v);
  }

  get changed(): Map<string, string | null> {
    return this.pending;
  }
}

/** One line of an old/new pair: 'keep' is in both, 'drop' only in the old, 'add' only in the new. */
interface Step {
  mode: 'keep' | 'drop' | 'add';
  text: string;
}

const oldRows = (steps: Step[]): string[] => steps.filter((s) => s.mode !== 'add').map((s) => s.text);
const newRows = (steps: Step[]): string[] => steps.filter((s) => s.mode !== 'drop').map((s) => s.text);

/** A line as a tier sees it. */
function clean(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every position where `want` occurs in `rows` at `tier` (overlaps allowed). */
function spots(rows: string[], want: string[], tier: number): number[] {
  const found: number[] = [];
  if (want.length === 0 || want.length > rows.length) return found;
  for (let i = 0; i + want.length <= rows.length; i += 1) {
    let hit = true;
    for (let j = 0; j < want.length; j += 1) {
      if (clean(rows[i + j] as string, tier) !== clean(want[j] as string, tier)) {
        hit = false;
        break;
      }
    }
    if (hit) found.push(i);
  }
  return found;
}

/** The first tier where `want` occurs at least once (tier 0 alone when strict). */
function locate(rows: string[], want: string[], strict: boolean): { tier: number; spots: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const at = spots(rows, want, t);
    if (at.length > 0) return { tier: t, spots: at };
  }
  return null;
}

/**
 * The rows that replace a match. A 'keep' row is the file's own matched row;
 * at tier 2 the other new rows are re-indented from the old rows' leading
 * whitespace to the file's.
 */
function stitch(steps: Step[], rows: string[], at: number, tier: number): string[] {
  const old = oldRows(steps);
  let fromFile = '';
  let fromOld = '';
  if (tier === 2 && old.length > 0) {
    fromFile = leading(rows[at] ?? '');
    fromOld = leading(old[0] as string);
  }
  const out: string[] = [];
  let oi = 0;
  for (const s of steps) {
    if (s.mode === 'keep') {
      out.push(rows[at + oi] as string);
      oi += 1;
    } else if (s.mode === 'drop') {
      oi += 1;
    } else if (tier === 2 && old.length > 0 && s.text !== '' && s.text.trim() !== '' && s.text.startsWith(fromOld)) {
      out.push(fromFile + s.text.slice(fromOld.length));
    } else {
      out.push(s.text);
    }
  }
  return out;
}

/** Replace the matched rows of a page with a step list's new rows. */
function cut(page: Page, at: number, steps: Step[], tier: number): void {
  const old = oldRows(steps);
  const rep = stitch(steps, page.rows, at, tier);
  page.rows.splice(at, old.length, ...rep);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if ((lines[first] as string).trim() === '*** Begin Patch') return 'v4a';
  const ch = (lines[first] as string).trimStart()[0];
  if (ch === '[' || ch === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  for (let i = 0; i < lines.length; i += 1) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) return 'unified';
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return 'unified';
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

type Edit = { exec(vault: Vault, moves: string[][]): void };

interface BodyRow {
  mark: ' ' | '-' | '+' | '\\';
  text: string;
  blank: boolean;
}

interface DiffHunk {
  at: number;
  body: BodyRow[];
  steps: Step[];
}

interface DiffFile {
  from: string | null;
  to: string | null;
  fromNull: boolean;
  toNull: boolean;
  gitFrom: string | null;
  gitTo: string | null;
  make: boolean;
  remove: boolean;
  hunks: DiffHunk[];
}

function stripPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` or `+++ `: up to the first tab, outer spaces off. */
function headerPath(line: string): string {
  const rest = (line.slice(4).split('\t')[0] as string).trim();
  return stripPrefix(rest);
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function readHunk(lines: string[], i: number): { hunk: DiffHunk; next: number } {
  const m = HUNK_RE.exec(lines[i] as string);
  if (m === null) throw new Halt(`error: parse ${i + 1}`);
  const at = Number(m[1]);
  const body: BodyRow[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j] as string;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ mark: ' ', text: '', blank: true });
      j += 1;
      continue;
    }
    const c = l[0] as string;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ mark: c as ' ' | '-' | '+' | '\\', text: l.slice(1), blank: false });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && (body[body.length - 1] as BodyRow).blank) body.pop();
  const steps: Step[] = [];
  for (const b of body) {
    if (b.mark === ' ') steps.push({ mode: 'keep', text: b.text });
    else if (b.mark === '-') steps.push({ mode: 'drop', text: b.text });
    else if (b.mark === '+') steps.push({ mode: 'add', text: b.text });
  }
  return { hunk: { at, body, steps }, next: j };
}

/** A `\` row sits right after the hunk's last context or `+` row. */
function noNewlineAfter(hunk: DiffHunk): boolean {
  let last = -1;
  for (let i = 0; i < hunk.body.length; i += 1) {
    const k = (hunk.body[i] as BodyRow).mark;
    if (k === ' ' || k === '+') last = i;
  }
  return last >= 0 && hunk.body[last + 1] !== undefined && (hunk.body[last + 1] as BodyRow).mark === '\\';
}

/** Read one section's header (up to its first hunk) and its hunks. */
function readDiffFile(lines: string[], i: number, file: DiffFile, startedWithPair: boolean): number {
  let minus: string | null = file.from;
  let plus: string | null = file.to;
  let minusNull = file.fromNull;
  let plusNull = file.toNull;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let havePair = startedWithPair;
  let make = file.make;
  let remove = file.remove;
  let j = i;
  while (j < lines.length) {
    const l = lines[j] as string;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
      if (!havePair) {
        const p1 = headerPath(l);
        const p2 = headerPath(lines[j + 1] as string);
        minusNull = p1 === '/dev/null';
        plusNull = p2 === '/dev/null';
        minus = minusNull ? null : p1;
        plus = plusNull ? null : p2;
        havePair = true;
      }
      j += 2;
      continue;
    }
    if (l.startsWith('--- ')) throw new Halt(`error: parse ${j + 2}`);
    if (l.startsWith('rename from ')) {
      if (renameFrom === null) renameFrom = (l.slice('rename from '.length).split('\t')[0] as string).trim();
      j += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (renameTo === null) renameTo = (l.slice('rename to '.length).split('\t')[0] as string).trim();
      j += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      make = true;
      j += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      remove = true;
      j += 1;
      continue;
    }
    j += 1;
  }
  if (havePair) {
    file.from = minusNull ? null : minus;
    file.to = plusNull ? null : plus;
  } else {
    file.from = minus ?? renameFrom ?? file.gitFrom;
    file.to = plus ?? renameTo ?? file.gitTo;
  }
  file.fromNull = minusNull;
  file.toNull = plusNull;
  file.make = make || minusNull;
  file.remove = !file.make && (remove || plusNull);
  while (j < lines.length) {
    const l = lines[j] as string;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const r = readHunk(lines, j);
      file.hunks.push(r.hunk);
      j = r.next;
      continue;
    }
    j += 1;
  }
  return j;
}

function parseDiff(lines: string[]): DiffFile[] {
  const files: DiffFile[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i] as string;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Halt(`error: parse ${i + 1}`);
      const file: DiffFile = {
        from: null,
        to: null,
        fromNull: false,
        toNull: false,
        gitFrom: m[1] as string,
        gitTo: m[2] as string,
        make: false,
        remove: false,
        hunks: [],
      };
      i = readDiffFile(lines, i + 1, file, false);
      files.push(file);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1] as string);
      const file: DiffFile = {
        from: oldP === '/dev/null' ? null : oldP,
        to: newP === '/dev/null' ? null : newP,
        fromNull: oldP === '/dev/null',
        toNull: newP === '/dev/null',
        gitFrom: null,
        gitTo: null,
        make: false,
        remove: false,
        hunks: [],
      };
      i = readDiffFile(lines, i + 2, file, true);
      files.push(file);
      continue;
    }
    if (l.startsWith('@@')) throw new Halt(`error: parse ${i + 1}`);
    i += 1;
  }
  return files;
}

/** Run a section's hunks over a page, in order, tracking the drift `d`. */
function applyDiffHunks(page: Page, hunks: DiffHunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const old = oldRows(hunk.steps);
    const next = newRows(hunk.steps);
    const bs = noNewlineAfter(hunk);
    if (old.length > 0) {
      const found = locate(page.rows, old, strict);
      if (found === null) throw new Slip('no-match', failPath);
      const target = hunk.at - 1 + d;
      let best = found.spots[0] as number;
      for (const p of found.spots) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const toEnd = best + old.length === page.rows.length;
      cut(page, best, hunk.steps, found.tier);
      page.tail = toEnd ? !bs : page.tail;
    } else {
      const at = Math.max(0, Math.min(hunk.at + d, page.rows.length));
      const atEnd = at === page.rows.length;
      page.rows.splice(at, 0, ...next);
      page.tail = atEnd ? !bs : page.tail;
    }
    d += next.length - old.length;
  }
}

function diffEdits(lines: string[], strict: boolean): Edit[] {
  const files = parseDiff(lines);
  if (files.length === 0) throw new Halt('error: parse 1');
  return files.map((file) => {
    const make = file.make;
    const remove = file.remove;
    return {
      exec(vault: Vault, moves: string[][]): void {
        const from = file.from;
        const to = file.to;
        if (from !== null && !isSafe(from)) throw new Slip('unsafe', from);
        if (to !== null && !isSafe(to)) throw new Slip('unsafe', to);
        if (make) {
          if (to === null) return;
          if (vault.now(to) !== null) throw new Slip('exists', to);
          const plus: string[] = [];
          for (const h of file.hunks) plus.push(...h.steps.filter((s) => s.mode === 'add').map((s) => s.text));
          let tail = false;
          if (plus.length > 0) {
            let bs = false;
            for (let k = file.hunks.length - 1; k >= 0; k -= 1) {
              const h = file.hunks[k] as DiffHunk;
              if (h.steps.some((s) => s.mode === 'add')) {
                bs = noNewlineAfter(h);
                break;
              }
            }
            tail = !bs;
          }
          vault.put(to, plus.length === 0 ? '' : plus.join('\n') + (tail ? '\n' : ''));
          return;
        }
        if (remove) {
          if (from === null) return;
          if (vault.now(from) === null) throw new Slip('missing', from);
          vault.put(from, null);
          return;
        }
        if (from !== null && to !== null && from !== to) {
          const cur = vault.now(from);
          if (cur === null) throw new Slip('missing', from);
          if (vault.now(to) !== null) throw new Slip('exists', to);
          const page = Page.parse(cur);
          applyDiffHunks(page, file.hunks, strict, from);
          vault.put(to, page.render());
          vault.put(from, null);
          moves.push([from, to]);
          return;
        }
        const p = from ?? to;
        if (p === null) return;
        const cur = vault.now(p);
        if (cur === null) throw new Slip('missing', p);
        const page = Page.parse(cur);
        applyDiffHunks(page, file.hunks, strict, p);
        vault.put(p, page.render());
      },
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface Block {
  path: string;
  old: string[];
  next: string[];
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    let j = -1;
    for (let k = i; k < lines.length; k += 1) {
      if ((lines[k] as string).trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k -= 1) {
      const l = lines[k] as string;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = (blocks[blocks.length - 1] as Block).path;
      else throw new Halt(`error: parse ${j + 1}`);
    }
    let sep = -1;
    for (let k = j + 1; k < lines.length; k += 1) {
      const t = (lines[k] as string).trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Halt(`error: parse ${j + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      const t = (lines[k] as string).trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Halt(`error: parse ${j + 1}`);
    blocks.push({ path, old: lines.slice(j + 1, sep), next: lines.slice(sep + 1, end) });
    prevEnd = end + 1;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Halt('error: parse 1');
  return blocks;
}

function blockEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseBlocks(lines);
  return blocks.map((b) => ({
    exec(vault: Vault): void {
      if (!isSafe(b.path)) throw new Slip('unsafe', b.path);
      if (b.old.length === 0) {
        if (vault.now(b.path) !== null) throw new Slip('exists', b.path);
        vault.put(b.path, b.next.length === 0 ? '' : b.next.join('\n') + '\n');
        return;
      }
      const cur = vault.now(b.path);
      if (cur === null) throw new Slip('missing', b.path);
      const page = Page.parse(cur);
      const found = locate(page.rows, b.old, strict);
      if (found === null) throw new Slip('no-match', b.path);
      if (found.spots.length > 1) throw new Slip('ambiguous', b.path);
      const steps: Step[] = [
        ...b.old.map((t): Step => ({ mode: 'drop', text: t })),
        ...b.next.map((t): Step => ({ mode: 'add', text: t })),
      ];
      cut(page, found.spots[0] as number, steps, found.tier);
      vault.put(b.path, page.render());
    },
  }));
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface VChunk {
  anchor: string | null;
  eof: boolean;
  steps: Step[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: VChunk[];
  updateLine: number;
}

function parseV4(lines: string[]): VSection[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Halt('error: parse 1');
  if ((lines[first] as string).trim() !== '*** Begin Patch') throw new Halt(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!blank(lines[k] as string)) {
      last = k;
      break;
    }
  }
  if ((lines[last] as string).trim() !== '*** End Patch') throw new Halt(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i] as string;
    if (blank(l)) {
      i += 1;
      continue;
    }
    let sec: VSection | null = null;
    if (l.startsWith('*** Add File: ')) sec = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    else if (l.startsWith('*** Delete File: ')) sec = { kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    else if (l.startsWith('*** Update File: ')) sec = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    else throw new Halt(`error: parse ${i + 1}`);
    i += 1;
    i = readV4Section(lines, i, last, sec);
    sections.push(sec);
  }
  if (sections.length === 0) throw new Halt('error: parse 1');
  return sections;
}

/** Read one V4A section's body; returns where the next section starts. */
function readV4Section(lines: string[], i: number, last: number, sec: VSection): number {
  const isStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let j = i;
  if (sec.kind === 'add') {
    while (j < last) {
      const l = lines[j] as string;
      if (isStart(l)) break;
      if (l === '') {
        sec.lines.push('');
        j += 1;
        continue;
      }
      if (l.startsWith('+')) {
        sec.lines.push(l.slice(1));
        j += 1;
        continue;
      }
      throw new Halt(`error: parse ${j + 1}`);
    }
    while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    return j;
  }
  if (sec.kind === 'delete') {
    while (j < last) {
      const l = lines[j] as string;
      if (isStart(l)) break;
      if (blank(l)) {
        j += 1;
        continue;
      }
      throw new Halt(`error: parse ${j + 1}`);
    }
    return j;
  }
  let chunk: VChunk | null = null;
  const closeChunk = (): void => {
    if (chunk !== null) {
      sec.chunks.push(chunk);
      chunk = null;
    }
  };
  while (j < last && blank(lines[j] as string)) j += 1;
  if (j < last && (lines[j] as string).startsWith('*** Move to: ')) {
    sec.moveTo = (lines[j] as string).slice('*** Move to: '.length).trim();
    j += 1;
    while (j < last && blank(lines[j] as string)) j += 1;
  }
  while (j < last) {
    const l = lines[j] as string;
    if (isStart(l)) break;
    if (blank(l)) {
      if (chunk !== null) chunk.steps.push({ mode: 'keep', text: '' });
      j += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, steps: [] };
      j += 1;
      continue;
    }
    if (l === '*** End of File') {
      if (chunk === null) throw new Halt(`error: parse ${j + 1}`);
      chunk.eof = true;
      closeChunk();
      j += 1;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Halt(`error: parse ${j + 1}`);
    if (l.startsWith('***')) throw new Halt(`error: parse ${j + 1}`);
    const c = l[0] as string;
    if (c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        if (sec.chunks.length > 0) throw new Halt(`error: parse ${j + 1}`);
        chunk = { anchor: null, eof: false, steps: [] };
      }
      if (c === ' ') chunk.steps.push({ mode: 'keep', text: l.slice(1) });
      else if (c === '-') chunk.steps.push({ mode: 'drop', text: l.slice(1) });
      else chunk.steps.push({ mode: 'add', text: l.slice(1) });
      j += 1;
      continue;
    }
    throw new Halt(`error: parse ${j + 1}`);
  }
  closeChunk();
  while (sec.chunks.length > 0) {
    const tail = sec.chunks[sec.chunks.length - 1] as VChunk;
    while (tail.steps.length > 0) {
      const o = tail.steps[tail.steps.length - 1] as Step;
      if (o.mode === 'keep' && o.text === '') tail.steps.pop();
      else break;
    }
    if (tail.steps.length === 0 && tail.anchor === null && !tail.eof) sec.chunks.pop();
    else break;
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Halt(`error: parse ${sec.updateLine}`);
  return j;
}

/** The first row at or after `from` equal to `anchor`, at the first tier with one. */
function findAnchor(rows: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = from; j < rows.length; j += 1) {
      if (clean(rows[j] as string, t) === clean(anchor, t)) return j;
    }
  }
  return null;
}

function v4Edits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4(lines);
  return sections.map((sec) => ({
    exec(vault: Vault, moves: string[][]): void {
      if (!isSafe(sec.path)) throw new Slip('unsafe', sec.path);
      if (sec.moveTo !== null && !isSafe(sec.moveTo)) throw new Slip('unsafe', sec.moveTo);
      if (sec.kind === 'add') {
        if (vault.now(sec.path) !== null) throw new Slip('exists', sec.path);
        vault.put(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
        return;
      }
      if (sec.kind === 'delete') {
        if (vault.now(sec.path) === null) throw new Slip('missing', sec.path);
        vault.put(sec.path, null);
        return;
      }
      const cur = vault.now(sec.path);
      if (cur === null) throw new Slip('missing', sec.path);
      if (sec.moveTo !== null && vault.now(sec.moveTo) !== null) throw new Slip('exists', sec.moveTo);
      const page = Page.parse(cur);
      let cursor = 0;
      for (const chunk of sec.chunks) {
        if (chunk.anchor !== null) {
          const at = findAnchor(page.rows, chunk.anchor, cursor, strict);
          if (at === null) throw new Slip('no-match', sec.path);
          cursor = at + 1;
        }
        const old = oldRows(chunk.steps);
        if (old.length === 0) {
          const at = chunk.eof ? page.rows.length : cursor;
          page.rows.splice(at, 0, ...newRows(chunk.steps));
          cursor = at + newRows(chunk.steps).length;
          continue;
        }
        const tiers = strict ? [0] : [0, 1, 2];
        let found: { tier: number; p: number } | null = null;
        for (const t of tiers) {
          const pos = spots(page.rows, old, t).filter((p) => p >= cursor && (!chunk.eof || p + old.length === page.rows.length));
          if (pos.length > 0) {
            found = { tier: t, p: pos[0] as number };
            break;
          }
        }
        if (found === null) throw new Slip('no-match', sec.path);
        const rep = stitch(chunk.steps, page.rows, found.p, found.tier);
        page.rows.splice(found.p, old.length, ...rep);
        cursor = found.p + rep.length;
      }
      const out = page.render();
      if (sec.moveTo !== null) {
        vault.put(sec.moveTo, out);
        vault.put(sec.path, null);
        moves.push([sec.path, sec.moveTo]);
      } else {
        vault.put(sec.path, out);
      }
    },
  }));
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object as an Edit, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return {
      exec(vault: Vault): void {
        if (!isSafe(p)) throw new Slip('unsafe', p);
        if (vault.now(p) !== null) throw new Slip('exists', p);
        vault.put(p, text);
      },
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return {
      exec(vault: Vault): void {
        if (!isSafe(p)) throw new Slip('unsafe', p);
        const before = vault.now(p);
        if (before === null) throw new Slip('missing', p);
        const nl = before.indexOf('\n');
        const crlf = nl > 0 && before[nl - 1] === '\r';
        const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
        const t = flat(before);
        const old = flat(oldStr);
        let count = 0;
        for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
        if (count === 0) throw new Slip('no-match', p);
        if (count > 1) throw new Slip('ambiguous', p);
        const at = t.indexOf(old);
        const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
        vault.put(p, crlf ? out.replaceAll('\n', '\r\n') : out);
      },
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return {
      exec(vault: Vault): void {
        if (!isSafe(p)) throw new Slip('unsafe', p);
        const before = vault.now(p);
        if (before === null) throw new Slip('missing', p);
        const page = Page.parse(before);
        if (line < 0 || line > page.rows.length) throw new Slip('no-match', p);
        page.rows.splice(line, 0, ...add);
        vault.put(p, page.render());
      },
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Halt('error: parse 1');
  const edits: Edit[] = [];
  if ((lines[first] as string).trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Halt(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Halt(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Halt(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Halt(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

function run(argv: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of argv) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && (KNOWN_FORMATS as readonly string[]).includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : (pos[0] as string);
  let text = '';
  try {
    text = fs.readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = diffEdits(lines, strict);
    else if (kind === 'search-replace') edits = blockEdits(lines, strict);
    else edits = v4Edits(lines, strict);
    if (edits.length === 0) throw new Halt('error: parse 1');
  } catch (e) {
    if (e instanceof Halt) return { code: 2, out: [e.text] };
    throw e;
  }
  const vault = new Vault();
  const moves: string[][] = [];
  const fails: Slip[] = [];
  for (const edit of edits) {
    const before = new Map(vault.changed);
    const movesBefore = moves.length;
    try {
      edit.exec(vault, moves);
    } catch (e) {
      if (!(e instanceof Slip)) throw e;
      vault.changed.clear();
      for (const [k, v] of before) vault.changed.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: { key: string; line: string }[] = [];
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const p of vault.changed.keys()) {
    const was = vault.orig(p);
    const now = vault.changed.get(p) as string | null;
    if (was === now) continue;
    if (was === null) added.add(p);
    else if (now === null) deleted.add(p);
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  const moveFrom = new Map<string, string>();
  for (const [o, n] of moves) {
    if (!moveFrom.has(o)) moveFrom.set(o, n);
  }
  for (const d of [...deleted]) {
    let target = moveFrom.get(d);
    let hops = 0;
    while (target !== undefined && moveFrom.has(target) && hops < moves.length) {
      target = moveFrom.get(target);
      hops += 1;
    }
    if (target !== undefined && vault.orig(target) === null && vault.now(target) !== null && vault.now(d) === null) {
      rows.splice(
        rows.findIndex((r) => r.line === `D ${d}`),
        1,
      );
      rows.splice(
        rows.findIndex((r) => r.line === `A ${target}`),
        1,
      );
      rows.push({ key: target, line: `R ${d} -> ${target}` });
      deleted.delete(d);
      added.delete(target);
    }
  }
  rows.sort((a, b) => byteCmp(a.key, b.key));
  if (!check) {
    for (const p of vault.changed.keys()) {
      const was = vault.orig(p);
      const now = vault.changed.get(p) as string | null;
      if (was === now) continue;
      if (now === null) fs.rmSync(p, { force: true });
      else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  fs.writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
