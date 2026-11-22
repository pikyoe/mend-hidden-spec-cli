// mend: one patch tool for every AI edit format.
//
// Reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks,
// V4A patches, JSON tool calls), applies it to the tree in the working
// directory, and writes every change or none. SPEC.md is the whole contract:
// this file is an independent implementation of it, written from the spec.
//
// Node 22, standard library only. Run as `node main.ts [options] [PATCH]`.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** A parse/usage/format failure: exit 2 with one line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: exit 1 with `error: <code> <path>`. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A patch's lines: split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safePath(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

const cmpBytes = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

/** One file as lines: its line break, its lines, whether it ends with a break. */
interface Doc {
  brk: string;
  lines: string[];
  finalBrk: boolean;
}

function parseDoc(text: string): Doc {
  if (text === '') return { brk: '\n', lines: [], finalBrk: false };
  const nl = text.indexOf('\n');
  const brk = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const finalBrk = text.endsWith(brk);
  const lines = text.split(brk);
  if (finalBrk) lines.pop();
  return { brk, lines, finalBrk };
}

function renderDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.brk) + (d.finalBrk ? d.brk : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted). */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  set(p: string, v: string | null): void {
    this.now.set(p, v);
  }
}

type Edit = (tree: Tree, moves: string[][]) => void;

/** One line of an old/new pair: 'c' context, 'o' old only, 'n' new only. */
interface Op {
  t: 'c' | 'o' | 'n';
  s: string;
}

const oldOf = (ops: Op[]): string[] => ops.filter((o) => o.t !== 'n').map((o) => o.s);
const newOf = (ops: Op[]): string[] => ops.filter((o) => o.t !== 'o').map((o) => o.s);

/** A line normalised at a matching tier. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Positions where `pat` occurs in `lines` at `tier` (occurrences may overlap). */
function occurrences(lines: string[], pat: string[], tier: number): number[] {
  const out: number[] = [];
  if (pat.length === 0 || pat.length > lines.length) return out;
  for (let i = 0; i + pat.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < pat.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(pat[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which `pat` occurs at least once (tier 0 only when strict). */
function findTier(lines: string[], pat: string[], strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, pat, t);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/**
 * The lines that replace a match: context lines are the file's own matched
 * lines; at tier 2 the other new lines are re-indented from the old lines'
 * leading whitespace to the file's.
 */
function buildReplacement(ops: Op[], fileLines: string[], at: number, tier: number): string[] {
  const o = oldOf(ops);
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0) {
    f = leadWs(fileLines[at] ?? '');
    p = leadWs(o[0]!);
  }
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.t === 'c') {
      out.push(fileLines[at + oi]!);
      oi += 1;
    } else if (op.t === 'o') {
      oi += 1;
    } else if (tier === 2 && o.length > 0 && op.s !== '' && op.s.trim() !== '' && op.s.startsWith(p)) {
      out.push(f + op.s.slice(p.length));
    } else {
      out.push(op.s);
    }
  }
  return out;
}

/** Apply one hunk/chunk's ops to a doc at a found position. */
function spliceOps(doc: Doc, at: number, ops: Op[], tier: number): void {
  const o = oldOf(ops);
  const rep = buildReplacement(ops, doc.lines, at, tier);
  doc.lines.splice(at, o.length, ...rep);
}

function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ------------------------------------------------------------------ */
/* Unified diffs (SPEC.md section 6)                                   */
/* ------------------------------------------------------------------ */

interface BodyLine {
  k: ' ' | '-' | '+' | '\\';
  s: string;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  ops: Op[];
}

/** The last context or + body line is immediately followed by a `\` line. */
function backslashAfterLast(hunk: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < hunk.body.length; i += 1) {
    if (hunk.body[i]!.k === ' ' || hunk.body[i]!.k === '+') last = i;
  }
  return last >= 0 && hunk.body[last + 1] !== undefined && hunk.body[last + 1]!.k === '\\';
}

interface Section {
  oldPath: string | null;
  newPath: string | null;
  minusDevNull: boolean;
  plusDevNull: boolean;
  diffOld: string | null;
  diffNew: string | null;
  creation: boolean;
  deletion: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

/** The path after `--- ` / `+++ `: up to the first tab, surrounding spaces removed. */
function headerPath(line: string): string {
  const rest = line.slice(4).split('\t')[0]!;
  return stripAB(rest.trim());
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseHunk(lines: string[], i: number): { hunk: Hunk; next: number } {
  const m = HUNK_RE.exec(lines[i]!);
  if (m === null) throw new Exit2(`error: parse ${i + 1}`);
  const a = Number(m[1]);
  const body: BodyLine[] = [];
  let j = i + 1;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '') {
      body.push({ k: ' ', s: '', rawEmpty: true });
      j += 1;
      continue;
    }
    const c = l[0]!;
    if (c === ' ' || c === '-' || c === '+' || c === '\\') {
      body.push({ k: c as ' ' | '-' | '+' | '\\', s: l.slice(1), rawEmpty: false });
      j += 1;
      continue;
    }
    break;
  }
  while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
  const ops: Op[] = [];
  for (const b of body) {
    if (b.k === ' ') ops.push({ t: 'c', s: b.s });
    else if (b.k === '-') ops.push({ t: 'o', s: b.s });
    else if (b.k === '+') ops.push({ t: 'n', s: b.s });
  }
  return { hunk: { a, body, ops }, next: j };
}

/** Parse one section's header (before its first hunk) and hunks. */
function parseSection(lines: string[], i: number, sec: Section, startedWithPair: boolean): number {
  let minus: string | null = sec.oldPath;
  let plus: string | null = sec.newPath;
  let minusDevNull = sec.minusDevNull;
  let plusDevNull = sec.plusDevNull;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let havePair = startedWithPair;
  let creation = sec.creation;
  let deletion = sec.deletion;
  let j = i;
  // Header: until the first hunk, the next section, or the end.
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('@@')) break;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) {
      if (!havePair) {
        const p1 = headerPath(l);
        const p2 = headerPath(lines[j + 1]!);
        minusDevNull = p1 === '/dev/null';
        plusDevNull = p2 === '/dev/null';
        minus = minusDevNull ? null : p1;
        plus = plusDevNull ? null : p2;
        havePair = true;
      }
      j += 2;
      continue;
    }
    if (l.startsWith('--- ')) throw new Exit2(`error: parse ${j + 2}`);
    if (l.startsWith('rename from ')) {
      if (renameFrom === null) renameFrom = l.slice('rename from '.length).split('\t')[0]!.trim();
      j += 1;
      continue;
    }
    if (l.startsWith('rename to ')) {
      if (renameTo === null) renameTo = l.slice('rename to '.length).split('\t')[0]!.trim();
      j += 1;
      continue;
    }
    if (l.startsWith('new file mode')) {
      creation = true;
      j += 1;
      continue;
    }
    if (l.startsWith('deleted file mode')) {
      deletion = true;
      j += 1;
      continue;
    }
    j += 1;
  }
  // Resolve the paths: the ---/+++ pair wins, then rename, then diff --git.
  // A /dev/null side names no file and blocks the fallbacks for that side.
  if (havePair) {
    sec.oldPath = minusDevNull ? null : minus;
    sec.newPath = plusDevNull ? null : plus;
  } else {
    sec.oldPath = minus ?? renameFrom ?? sec.diffOld;
    sec.newPath = plus ?? renameTo ?? sec.diffNew;
  }
  sec.minusDevNull = minusDevNull;
  sec.plusDevNull = plusDevNull;
  sec.creation = creation || minusDevNull;
  sec.deletion = !sec.creation && (deletion || plusDevNull);
  // Hunks: until the next section or the end; other lines are ignored.
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l.startsWith('@@')) {
      const r = parseHunk(lines, j);
      sec.hunks.push(r.hunk);
      j = r.next;
      continue;
    }
    j += 1;
  }
  return j;
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const sec: Section = {
        oldPath: null,
        newPath: null,
        minusDevNull: false,
        plusDevNull: false,
        diffOld: m[1]!,
        diffNew: m[2]!,
        creation: false,
        deletion: false,
        hunks: [],
      };
      i = parseSection(lines, i + 1, sec, false);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      const sec: Section = {
        oldPath: oldP === '/dev/null' ? null : oldP,
        newPath: newP === '/dev/null' ? null : newP,
        minusDevNull: oldP === '/dev/null',
        plusDevNull: newP === '/dev/null',
        diffOld: null,
        diffNew: null,
        creation: false,
        deletion: false,
        hunks: [],
      };
      i = parseSection(lines, i + 2, sec, true);
      sections.push(sec);
      continue;
    }
    if (l.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
  }
  return sections;
}

/** Apply a section's hunks to a doc, in order, with the drift offset d. */
function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, failPath: string): void {
  let d = 0;
  for (const hunk of hunks) {
    const o = oldOf(hunk.ops);
    const n = newOf(hunk.ops);
    const bs = backslashAfterLast(hunk);
    if (o.length > 0) {
      const found = findTier(doc.lines, o, strict);
      if (found === null) throw new Fail('no-match', failPath);
      const target = hunk.a - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const matchedToEnd = best + o.length === doc.lines.length;
      spliceOps(doc, best, hunk.ops, found.tier);
      doc.finalBrk = matchedToEnd ? !bs : doc.finalBrk;
    } else {
      const at = Math.max(0, Math.min(hunk.a + d, doc.lines.length));
      const insertedAtEnd = at === doc.lines.length;
      doc.lines.splice(at, 0, ...n);
      doc.finalBrk = insertedAtEnd ? !bs : doc.finalBrk;
    }
    d += n.length - o.length;
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((sec) => {
    const creation = sec.creation;
    const deletion = sec.deletion;
    return (tree: Tree, moves: string[][]): void => {
      const oldP = sec.oldPath;
      const newP = sec.newPath;
      // Safety first, old path then new path; /dev/null names no file.
      if (oldP !== null && !safePath(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && !safePath(newP)) throw new Fail('unsafe', newP);
      if (creation) {
        if (newP === null) return;
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plusLines: string[] = [];
        for (const h of sec.hunks) plusLines.push(...h.ops.filter((o) => o.t === 'n').map((o) => o.s));
        let finalBrk = false;
        if (plusLines.length > 0) {
          let bs = false;
          for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
            const h = sec.hunks[k]!;
            if (h.ops.some((o) => o.t === 'n')) {
              bs = backslashAfterLast(h);
              break;
            }
          }
          finalBrk = !bs;
        }
        tree.set(newP, plusLines.length === 0 ? '' : plusLines.join('\n') + (finalBrk ? '\n' : ''));
        return;
      }
      if (deletion) {
        if (oldP === null) return;
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.set(oldP, null);
        return;
      }
      if (oldP !== null && newP !== null && oldP !== newP) {
        const cur = tree.get(oldP);
        if (cur === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const doc = parseDoc(cur);
        applyHunks(doc, sec.hunks, strict, oldP);
        tree.set(newP, renderDoc(doc));
        tree.set(oldP, null);
        moves.push([oldP, newP]);
        return;
      }
      const p = oldP ?? newP;
      if (p === null) return;
      const cur = tree.get(p);
      if (cur === null) throw new Fail('missing', p);
      const doc = parseDoc(cur);
      applyHunks(doc, sec.hunks, strict, p);
      tree.set(p, renderDoc(doc));
    };
  });
}

/* ------------------------------------------------------------------ */
/* SEARCH/REPLACE blocks (SPEC.md section 7)                           */
/* ------------------------------------------------------------------ */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let i = 0;
  let prevEnd = 0;
  while (i < lines.length) {
    let j = -1;
    for (let k = i; k < lines.length; k += 1) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    // The path: nearest non-blank, non-fence line before the SEARCH line,
    // after the previous block's REPLACE line.
    let path: string | null = null;
    for (let k = j - 1; k >= prevEnd; k -= 1) {
      const l = lines[k]!;
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      else throw new Exit2(`error: parse ${j + 1}`);
    }
    // The ======= separator, then the >>>>>>> REPLACE line.
    let sep = -1;
    for (let k = j + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '=======') {
        sep = k;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (sep < 0) throw new Exit2(`error: parse ${j + 1}`);
    let end = -1;
    for (let k = sep + 1; k < lines.length; k += 1) {
      const t = lines[k]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        end = k;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (end < 0) throw new Exit2(`error: parse ${j + 1}`);
    blocks.push({ path, oldLines: lines.slice(j + 1, sep), newLines: lines.slice(sep + 1, end) });
    prevEnd = end + 1;
    i = end + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks;
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => (tree: Tree): void => {
    if (!safePath(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new Fail('missing', b.path);
    const doc = parseDoc(cur);
    const found = findTier(doc.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.pos.length > 1) throw new Fail('ambiguous', b.path);
    const ops: Op[] = [
      ...b.oldLines.map((s): Op => ({ t: 'o', s })),
      ...b.newLines.map((s): Op => ({ t: 'n', s })),
    ];
    spliceOps(doc, found.pos[0]!, ops, found.tier);
    tree.set(b.path, renderDoc(doc));
  });
}

/* ------------------------------------------------------------------ */
/* V4A patches (SPEC.md section 8)                                     */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

function parseV4a(lines: string[]): V4aSection[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (isBlank(l)) {
      i += 1;
      continue;
    }
    let sec: V4aSection | null = null;
    if (l.startsWith('*** Add File: ')) sec = { kind: 'add', path: l.slice('*** Add File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    else if (l.startsWith('*** Delete File: ')) sec = { kind: 'delete', path: l.slice('*** Delete File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    else if (l.startsWith('*** Update File: ')) sec = { kind: 'update', path: l.slice('*** Update File: '.length).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    else throw new Exit2(`error: parse ${i + 1}`);
    i += 1;
    i = parseV4aSection(lines, i, last, sec);
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections;
}

/** Parse one V4A section's body; returns the index of the next section's start. */
function parseV4aSection(lines: string[], i: number, last: number, sec: V4aSection): number {
  const isSectionStart = (l: string): boolean =>
    l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  let j = i;
  if (sec.kind === 'add') {
    while (j < last) {
      const l = lines[j]!;
      if (isSectionStart(l)) break;
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
      throw new Exit2(`error: parse ${j + 1}`);
    }
    while (sec.lines.length > 0 && sec.lines[sec.lines.length - 1] === '') sec.lines.pop();
    return j;
  }
  if (sec.kind === 'delete') {
    while (j < last) {
      const l = lines[j]!;
      if (isSectionStart(l)) break;
      if (isBlank(l)) {
        j += 1;
        continue;
      }
      throw new Exit2(`error: parse ${j + 1}`);
    }
    return j;
  }
  // Update: optional Move to first, then chunks.
  let chunk: V4aChunk | null = null;
  const closeChunk = (): void => {
    if (chunk !== null) {
      sec.chunks.push(chunk);
      chunk = null;
    }
  };
  // Blank lines before the Move to line or the first chunk are ignored.
  while (j < last && isBlank(lines[j]!)) j += 1;
  if (j < last && lines[j]!.startsWith('*** Move to: ')) {
    sec.moveTo = lines[j]!.slice('*** Move to: '.length).trim();
    j += 1;
    while (j < last && isBlank(lines[j]!)) j += 1;
  }
  while (j < last) {
    const l = lines[j]!;
    if (isSectionStart(l)) break;
    if (isBlank(l)) {
      // A blank line inside a chunk is an empty context line; between
      // chunks, or after an End of File line, it is ignored.
      if (chunk !== null) chunk.ops.push({ t: 'c', s: '' });
      j += 1;
      continue;
    }
    if (l.startsWith('@@')) {
      closeChunk();
      const anchor = l.slice(2).trim();
      chunk = { anchor: anchor === '' ? null : anchor, eof: false, ops: [] };
      j += 1;
      continue;
    }
    if (l === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${j + 1}`);
      chunk.eof = true;
      closeChunk();
      j += 1;
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${j + 1}`);
    if (l.startsWith('***')) throw new Exit2(`error: parse ${j + 1}`);
    const c = l[0];
    if (c === ' ' || c === '-' || c === '+') {
      if (chunk === null) {
        if (sec.chunks.length > 0) throw new Exit2(`error: parse ${j + 1}`);
        chunk = { anchor: null, eof: false, ops: [] };
      }
      if (c === ' ') chunk.ops.push({ t: 'c', s: l.slice(1) });
      else if (c === '-') chunk.ops.push({ t: 'o', s: l.slice(1) });
      else chunk.ops.push({ t: 'n', s: l.slice(1) });
      j += 1;
      continue;
    }
    throw new Exit2(`error: parse ${j + 1}`);
  }
  closeChunk();
  // Blank lines at the end of the section are not part of it.
  while (sec.chunks.length > 0) {
    const lastChunk = sec.chunks[sec.chunks.length - 1]!;
    while (lastChunk.ops.length > 0) {
      const o = lastChunk.ops[lastChunk.ops.length - 1]!;
      if (o.t === 'c' && o.s === '') lastChunk.ops.pop();
      else break;
    }
    if (lastChunk.ops.length === 0 && lastChunk.anchor === null && !lastChunk.eof) sec.chunks.pop();
    else break;
  }
  if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
  return j;
}

/** First line at or after `from` equal to `anchor` at the first tier with one. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    for (let j = from; j < lines.length; j += 1) {
      if (normLine(lines[j]!, t) === normLine(anchor, t)) return j;
    }
  }
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseV4a(lines);
  return sections.map((sec) => (tree: Tree, moves: string[][]): void => {
    if (!safePath(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safePath(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    if (sec.kind === 'add') {
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.set(sec.path, null);
      return;
    }
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const doc = parseDoc(cur);
    let cursor = 0;
    for (const chunk of sec.chunks) {
      if (chunk.anchor !== null) {
        const at = findAnchor(doc.lines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', sec.path);
        cursor = at + 1;
      }
      const o = oldOf(chunk.ops);
      if (o.length === 0) {
        const at = chunk.eof ? doc.lines.length : cursor;
        doc.lines.splice(at, 0, ...newOf(chunk.ops));
        cursor = at + newOf(chunk.ops).length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let found: { tier: number; p: number } | null = null;
      for (const t of tiers) {
        const pos = occurrences(doc.lines, o, t).filter((p) => p >= cursor && (!chunk.eof || p + o.length === doc.lines.length));
        if (pos.length > 0) {
          found = { tier: t, p: pos[0]! };
          break;
        }
      }
      if (found === null) throw new Fail('no-match', sec.path);
      const rep = buildReplacement(chunk.ops, doc.lines, found.p, found.tier);
      doc.lines.splice(found.p, o.length, ...rep);
      cursor = found.p + rep.length;
    }
    const out = renderDoc(doc);
    if (sec.moveTo !== null) {
      tree.set(sec.moveTo, out);
      tree.set(sec.path, null);
      moves.push([sec.path, sec.moveTo]);
    } else {
      tree.set(sec.path, out);
    }
  });
}

/* ------------------------------------------------------------------ */
/* JSON edits (SPEC.md section 9)                                      */
/* ------------------------------------------------------------------ */

/** One JSON edit object, or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree: Tree): void => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree: Tree): void => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const flat = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = flat(before);
      const old = flat(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + flat(newStr) + t.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree: Tree): void => {
      if (!safePath(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseDoc(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      doc.lines.splice(line, 0, ...add);
      tree.set(p, renderDoc(doc));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Running the CLI (SPEC.md sections 1, 2 and 10)                      */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detectFormat(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const moves: string[][] = [];
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // The changed paths, in byte order; a move replaces its D and A lines.
  const rows: { key: string; line: string }[] = [];
  const added = new Set<string>();
  const deleted = new Set<string>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
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
    if (target !== undefined && tree.original(target) === null && tree.get(target) !== null && tree.get(d) === null) {
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
  rows.sort((a, b) => cmpBytes(a.key, b.key));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const n = rows.length;
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${n} ${n === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
