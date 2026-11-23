// main.ts — mend, the CLI SPEC.md specifies. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md v1: the command line, output and exit codes, safe paths, format
// detection, matching lines at three tiers, unified diffs, SEARCH/REPLACE blocks,
// V4A patches, JSON edits, and the all-or-nothing write. In a trial the grader runs
// `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** origin: current path -> pre-patch path it was moved from (move edits only). */
  readonly origin = new Map<string, string>();

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

  set(p: string, text: string): void {
    this.now.set(p, text);
  }

  create(p: string, text: string): void {
    this.origin.delete(p);
    this.now.set(p, text);
  }

  del(p: string): void {
    this.origin.delete(p);
    this.now.set(p, null);
  }

  move(from: string, to: string, text: string): void {
    const o = this.origin.get(from) ?? from;
    this.origin.delete(from);
    this.origin.set(to, o);
    this.now.set(from, null);
    this.now.set(to, text);
  }
}

// ---- files and lines (SPEC section 3) ----

interface FileModel {
  br: '\n' | '\r\n';
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileModel {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\n' | '\r\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function renderFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.finalBreak ? m.br : '');
}

// ---- matching lines (SPEC section 5) ----

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

interface TierOcc {
  tier: number;
  occ: number[];
}

function occurrencesAtTier(lines: string[], o: string[], tier: number, start: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = start; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

// First tier (0, then 1, then 2; with --strict only tier 0) with at least one
// occurrence at or after `start`, together with all its occurrences there.
function firstTierOcc(lines: string[], o: string[], start: number, strict: boolean): TierOcc | null {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    const occ = occurrencesAtTier(lines, o, tier, start);
    if (occ.length > 0) return { tier, occ };
  }
  return null;
}

// Re-indent one replacement line at tier 2: if the line is not empty and not only
// whitespace, and starts with P (the leading whitespace of O's first line), that
// P is replaced by F (the leading whitespace of the file's first matched line).
function reindentLine(t: string, tier: number, f: string, p: string): string {
  if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
  return t;
}

type OpKind = 'ctx' | 'del' | 'add';
interface Op {
  kind: OpKind;
  text: string;
}

// Apply a sequence of ops at position `pos` in `lines` (O matched there at `tier`).
// Context lines are written as the file's own matched lines; deleted lines are
// dropped; added lines are written as the patch gives them (with re-indentation).
function applyOps(lines: string[], pos: number, ops: Op[], tier: number): string[] {
  const oLines = ops.filter((op) => op.kind !== 'add').map((op) => op.text);
  const f = leadWs(lines[pos] ?? '');
  const p = leadWs(oLines[0] ?? '');
  const out: string[] = [];
  let oIdx = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(lines[pos + oIdx]!);
      oIdx++;
    } else if (op.kind === 'del') {
      oIdx++;
    } else {
      out.push(reindentLine(op.text, tier, f, p));
    }
  }
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + oLines.length)];
}

// Replace O (matched at `pos` at `tier`) with N lines outright (SEARCH/REPLACE).
function applyReplacement(lines: string[], pos: number, oLines: string[], nLines: string[], tier: number): string[] {
  const f = leadWs(lines[pos] ?? '');
  const p = leadWs(oLines[0] ?? '');
  const out = nLines.map((t) => reindentLine(t, tier, f, p));
  return [...lines.slice(0, pos), ...out, ...lines.slice(pos + oLines.length)];
}

// ---- format detection (SPEC section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

type Edit = (tree: Tree) => void;

/** One JSON edit object (SPEC section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
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
    if (blank(l)) return;
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

// ---- unified diffs (SPEC section 6) ----

interface UnifiedHunk {
  a: number;
  ops: Op[];
  noEol: boolean;
  lastPlusNoEol: boolean;
}

function stripPathPrefix(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(l: string): { kind: 'path'; value: string } | { kind: 'devnull' } | { kind: 'none' } {
  const rest = l.slice(4);
  const head = rest.split('\t')[0]!;
  const p = head.trim();
  if (p === '') return { kind: 'none' };
  if (p === '/dev/null') return { kind: 'devnull' };
  return { kind: 'path', value: stripPathPrefix(p) };
}

interface UnifiedSection {
  startLine: number;
  oldKind: 'path' | 'devnull' | 'none';
  oldVal: string | null;
  newKind: 'path' | 'devnull' | 'none';
  newVal: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  gitOld: string | null;
  gitNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hasPair: boolean;
  hunks: UnifiedHunk[];
}

function sectionEdit(sec: UnifiedSection, strict: boolean): Edit {
  return (tree: Tree) => {
    const oldPath =
      sec.oldKind === 'path'
        ? sec.oldVal
        : sec.renameFrom ?? sec.gitOld ?? (sec.newKind === 'path' ? sec.newVal : null);
    const newPath =
      sec.newKind === 'path'
        ? sec.newVal
        : sec.renameTo ?? sec.gitNew ?? (sec.oldKind === 'path' ? sec.oldVal : null);
    const isCreation = sec.oldKind === 'devnull' || sec.newFile;
    const isDeletion = sec.newKind === 'devnull' || sec.deletedFile;
    if (isCreation) {
      if (newPath === null) throw new Exit2(`error: parse ${sec.startLine}`);
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plusLines: string[] = [];
      let lastPlusNoEol = false;
      for (const hunk of sec.hunks) {
        for (const op of hunk.ops) {
          if (op.kind === 'add') plusLines.push(op.text);
        }
        if (hunk.ops.some((op) => op.kind === 'add')) lastPlusNoEol = hunk.lastPlusNoEol;
      }
      const text = plusLines.length === 0 ? '' : plusLines.join('\n') + (lastPlusNoEol ? '' : '\n');
      tree.create(newPath, text);
      return;
    }
    if (isDeletion) {
      if (oldPath === null) throw new Exit2(`error: parse ${sec.startLine}`);
      if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
      if (tree.get(oldPath) === null) throw new Fail('missing', oldPath);
      tree.del(oldPath);
      return;
    }
    if (oldPath === null || newPath === null) throw new Exit2(`error: parse ${sec.startLine}`);
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    if (!safe(newPath)) throw new Fail('unsafe', newPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    const isMove = oldPath !== newPath;
    if (isMove && tree.get(newPath) !== null) throw new Fail('exists', newPath);
    let model = parseFile(before);
    let d = 0;
    for (const hunk of sec.hunks) {
      model = applyUnifiedHunk(model, hunk, d, oldPath, strict);
      const oLen = hunk.ops.filter((o) => o.kind !== 'add').length;
      const nLen = hunk.ops.filter((o) => o.kind !== 'del').length;
      d += nLen - oLen;
    }
    const out = renderFile(model);
    if (isMove) tree.move(oldPath, newPath, out);
    else tree.set(oldPath, out);
  };
}

function applyUnifiedHunk(model: FileModel, hunk: UnifiedHunk, d: number, path: string, strict: boolean): FileModel {
  const lines = model.lines;
  const oLines = hunk.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
  if (oLines.length === 0) {
    const idx = Math.min(Math.max(hunk.a + d, 0), lines.length);
    const addLines = hunk.ops.filter((o) => o.kind === 'add').map((o) => o.text);
    const newLines = [...lines.slice(0, idx), ...addLines, ...lines.slice(idx)];
    const atEnd = idx === lines.length;
    return { br: model.br, lines: newLines, finalBreak: atEnd && hunk.noEol ? false : model.finalBreak };
  }
  const found = firstTierOcc(lines, oLines, 0, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0]!;
  for (const p of found.occ) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const newLines = applyOps(lines, best, hunk.ops, found.tier);
  const runsToEnd = best + oLines.length === lines.length;
  return { br: model.br, lines: newLines, finalBreak: runsToEnd && hunk.noEol ? false : model.finalBreak };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let section: UnifiedSection | null = null;
  let inHeader = false;
  const finishSection = () => {
    if (section !== null) {
      edits.push(sectionEdit(section, strict));
      section = null;
      inHeader = false;
    }
  };
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      finishSection();
      section = {
        startLine: i + 1,
        oldKind: 'none',
        oldVal: null,
        newKind: 'none',
        newVal: null,
        renameFrom: null,
        renameTo: null,
        gitOld: m[1]!,
        gitNew: m[2]!,
        newFile: false,
        deletedFile: false,
        hasPair: false,
        hunks: [],
      };
      inHeader = true;
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (section !== null && inHeader && !section.hasPair) {
        const oldP = headerPath(l);
        const newP = headerPath(lines[i + 1]!);
        section.oldKind = oldP.kind;
        section.oldVal = oldP.kind === 'path' ? oldP.value : null;
        section.newKind = newP.kind;
        section.newVal = newP.kind === 'path' ? newP.value : null;
        section.hasPair = true;
        i += 2;
        continue;
      }
      finishSection();
      const oldP = headerPath(l);
      const newP = headerPath(lines[i + 1]!);
      section = {
        startLine: i + 1,
        oldKind: oldP.kind,
        oldVal: oldP.kind === 'path' ? oldP.value : null,
        newKind: newP.kind,
        newVal: newP.kind === 'path' ? newP.value : null,
        renameFrom: null,
        renameTo: null,
        gitOld: null,
        gitNew: null,
        newFile: false,
        deletedFile: false,
        hasPair: true,
        hunks: [],
      };
      inHeader = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (section === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]!);
      i++;
      const items: (Op | 'backslash')[] = [];
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') {
          items.push({ kind: 'ctx', text: '' });
          i++;
        } else if (b.startsWith(' ')) {
          items.push({ kind: 'ctx', text: b.slice(1) });
          i++;
        } else if (b.startsWith('-')) {
          items.push({ kind: 'del', text: b.slice(1) });
          i++;
        } else if (b.startsWith('+')) {
          items.push({ kind: 'add', text: b.slice(1) });
          i++;
        } else if (b.startsWith('\\')) {
          items.push('backslash');
          i++;
        } else {
          break;
        }
      }
      while (items.length > 0) {
        const last = items[items.length - 1]!;
        if (last !== 'backslash' && last.kind === 'ctx' && last.text === '') items.pop();
        else break;
      }
      const ops = items.filter((it): it is Op => it !== 'backslash');
      let noEol = false;
      let lastCtxAdd = -1;
      let lastPlusItem = -1;
      for (let k = 0; k < items.length; k++) {
        const it = items[k]!;
        if (it !== 'backslash' && (it.kind === 'ctx' || it.kind === 'add')) lastCtxAdd = k;
        if (it !== 'backslash' && it.kind === 'add') lastPlusItem = k;
      }
      if (lastCtxAdd >= 0 && items[lastCtxAdd + 1] === 'backslash') noEol = true;
      const lastPlusNoEol = lastPlusItem >= 0 && items[lastPlusItem + 1] === 'backslash';
      section.hunks.push({ a, ops, noEol, lastPlusNoEol });
      inHeader = false;
      continue;
    }
    if (section !== null && inHeader) {
      if (l.startsWith('--- ')) {
        throw new Exit2(`error: parse ${i + 2}`);
      }
      if (l.startsWith('rename from ')) {
        const p = l.slice('rename from '.length).trim();
        if (p !== '') section.renameFrom = p;
        i++;
        continue;
      }
      if (l.startsWith('rename to ')) {
        const p = l.slice('rename to '.length).trim();
        if (p !== '') section.renameTo = p;
        i++;
        continue;
      }
      if (l.startsWith('new file mode')) {
        section.newFile = true;
        i++;
        continue;
      }
      if (l.startsWith('deleted file mode')) {
        section.deletedFile = true;
        i++;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  finishSection();
  return edits;
}

// ---- SEARCH/REPLACE blocks (SPEC section 7) ----

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let eq = -1;
      for (let j = i + 1; j < lines.length; j++) {
        const t = lines[j]!.trimEnd();
        if (t === '=======') {
          eq = j;
          break;
        }
        if (t === '>>>>>>> REPLACE') break;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      let gt = -1;
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          gt = j;
          break;
        }
      }
      if (gt < 0) throw new Exit2(`error: parse ${searchLine}`);
      const oldLines = lines.slice(i + 1, eq);
      const newLines = lines.slice(eq + 1, gt);
      let path: string | null = null;
      for (let j = i - 1; j >= prevEnd; j--) {
        const t = lines[j]!.trim();
        if (t === '') continue;
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) path = prevPath;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      edits.push(srEdit(path, oldLines, newLines, strict));
      prevPath = path;
      prevEnd = gt + 1;
      i = gt + 1;
    } else {
      i++;
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      const text = newLines.length === 0 ? '' : newLines.join('\n') + '\n';
      tree.create(path, text);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const model = parseFile(before);
    const found = firstTierOcc(model.lines, oldLines, 0, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const newLines2 = applyReplacement(model.lines, pos, oldLines, newLines, found.tier);
    const out = renderFile({ br: model.br, lines: newLines2, finalBreak: model.finalBreak });
    tree.set(path, out);
  };
}

// ---- V4A patches (SPEC section 8) ----

interface V4aChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

function makeV4aAdd(path: string, secLines: string[]): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    const text = secLines.length === 0 ? '' : secLines.join('\n') + '\n';
    tree.create(path, text);
  };
}

function makeV4aDelete(path: string): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.del(path);
  };
}

function findAnchor(lines: string[], anchor: string, start: number, strict: boolean): number {
  const maxTier = strict ? 0 : 2;
  for (let tier = 0; tier <= maxTier; tier++) {
    for (let i = start; i < lines.length; i++) {
      if (lineEq(lines[i]!, anchor, tier)) return i;
    }
  }
  return -1;
}

function makeV4aUpdate(path: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree: Tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let model = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const idx = findAnchor(model.lines, chunk.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', path);
        cursor = idx + 1;
      }
      const oLines = chunk.ops.filter((o) => o.kind !== 'add').map((o) => o.text);
      if (oLines.length === 0) {
        const addLines = chunk.ops.filter((o) => o.kind === 'add').map((o) => o.text);
        const at = chunk.eof ? model.lines.length : cursor;
        const newLines = [...model.lines.slice(0, at), ...addLines, ...model.lines.slice(at)];
        model = { br: model.br, lines: newLines, finalBreak: model.finalBreak };
        cursor = at + addLines.length;
      } else {
        const found = firstTierOcc(model.lines, oLines, cursor, strict);
        if (found === null) throw new Fail('no-match', path);
        let pos = found.occ[0]!;
        if (chunk.eof) {
          const ok = found.occ.find((p) => p + oLines.length === model.lines.length);
          if (ok === undefined) throw new Fail('no-match', path);
          pos = ok;
        }
        const newLines = applyOps(model.lines, pos, chunk.ops, found.tier);
        const nLen = chunk.ops.filter((o) => o.kind !== 'del').length;
        model = { br: model.br, lines: newLines, finalBreak: model.finalBreak };
        cursor = pos + nLen;
      }
    }
    const out = renderFile(model);
    if (moveTo !== null) tree.move(path, moveTo, out);
    else tree.set(path, out);
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const end = last;
  let i = first + 1;
  while (i < end) {
    const l = lines[i]!;
    if (blank(l)) {
      i++;
      continue;
    }
    if (l.startsWith('*** Add File: ')) {
      const path = l.slice('*** Add File: '.length).trim();
      i++;
      const secLines: string[] = [];
      while (i < end) {
        const m = lines[i]!;
        if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
        if (m.startsWith('+')) {
          secLines.push(m.slice(1));
          i++;
        } else if (m === '') {
          secLines.push('');
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      while (secLines.length > 0 && secLines[secLines.length - 1] === '') secLines.pop();
      edits.push(makeV4aAdd(path, secLines));
    } else if (l.startsWith('*** Delete File: ')) {
      const path = l.slice('*** Delete File: '.length).trim();
      edits.push(makeV4aDelete(path));
      i++;
    } else if (l.startsWith('*** Update File: ')) {
      const path = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let chunkStarted = false;
      while (i < end) {
        const m = lines[i]!;
        if (m.startsWith('*** Add File: ') || m.startsWith('*** Delete File: ') || m.startsWith('*** Update File: ')) break;
        if (m.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          const a = m.slice(2).trim();
          cur = { anchor: a === '' ? null : a, ops: [], eof: false };
          chunkStarted = true;
          i++;
        } else if (m === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i++;
        } else if (m.startsWith(' ') || m.startsWith('-') || m.startsWith('+') || m === '') {
          if (cur === null) {
            if (chunkStarted) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, ops: [], eof: false };
            chunkStarted = true;
          }
          cur.ops.push(
            m === ''
              ? { kind: 'ctx', text: '' }
              : m[0] === ' '
                ? { kind: 'ctx', text: m.slice(1) }
                : m[0] === '-'
                  ? { kind: 'del', text: m.slice(1) }
                  : { kind: 'add', text: m.slice(1) },
          );
          i++;
        } else {
          throw new Exit2(`error: parse ${i + 1}`);
        }
      }
      if (cur !== null) chunks.push(cur);
      if (chunks.length > 0) {
        const lastChunk = chunks[chunks.length - 1]!;
        while (lastChunk.ops.length > 0) {
          const op = lastChunk.ops[lastChunk.ops.length - 1]!;
          if (op.kind === 'ctx' && op.text === '') lastChunk.ops.pop();
          else break;
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(makeV4aUpdate(path, moveTo, chunks, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---- CLI (SPEC sections 1, 2 and 10) ----

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
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeOrigin = new Map(tree.origin);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.origin.clear();
      for (const [k, v] of beforeOrigin) tree.origin.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; text: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now !== null && was === null) {
      const orig = tree.origin.get(p);
      if (orig !== undefined && tree.original(orig) !== null && tree.get(orig) === null) {
        rows.push({ key: p, text: `R ${orig} -> ${p}` });
      } else {
        rows.push({ key: p, text: `A ${p}` });
      }
    } else if (now === null && was !== null) {
      let isMoveSource = false;
      for (const [t, o] of tree.origin) {
        if (o === p && tree.original(t) === null && tree.get(t) !== null) {
          isMoveSource = true;
          break;
        }
      }
      if (isMoveSource) continue;
      rows.push({ key: p, text: `D ${p}` });
    } else {
      rows.push({ key: p, text: `M ${p}` });
    }
  }
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
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
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
