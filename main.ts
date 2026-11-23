// mend implements the patch CLI defined in SPEC.md using Node 22 and the standard library.

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
  readonly moves: [string, string][] = [];
  move(old: string, destination: string): void {
    this.now.set(old, null);
    this.moves.push([old, destination]);
  }
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
}

type Edit = (tree: Tree) => void;

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

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
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

function parseError(index: number): never {
  throw new Exit2(`error: parse ${index + 1}`);
}

function checkPaths(...paths: (string | null)[]): void {
  for (const path of paths) {
    if (path !== null && !safe(path)) throw new Fail('unsafe', path);
  }
}

function requireFile(tree: Tree, path: string): string {
  const text = tree.get(path);
  if (text === null) throw new Fail('missing', path);
  return text;
}

function requireAbsent(tree: Tree, path: string): void {
  if (tree.get(path) !== null) throw new Fail('exists', path);
}

function splitFile(text: string) {
  const firstLF = text.indexOf('\n');
  const br = firstLF > 0 && text[firstLF - 1] === '\r' ? '\r\n' : '\n';
  const lines = text === '' ? [] : text.split(br);
  const final = text.endsWith(br);
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile(lines: string[], br = '\n', final = true): string {
  return lines.length === 0 ? '' : lines.join(br) + (final ? br : '');
}

type Tier = 0 | 1 | 2;
const indentation = (line: string): string => /^[ \t]*/.exec(line)![0];

function findMatches(
  lines: string[], old: string[], strict: boolean, path: string, cursor = 0, eof = false,
): { tier: Tier; positions: number[] } {
  const last = lines.length - old.length;
  for (const tier of [0, 1, 2] as const) {
    if (strict && tier !== 0) break;
    const normalize = (line: string): string => {
      if (tier === 0) return line;
      const trimmed = line.replace(/[ \t]+$/, '');
      return tier === 1 ? trimmed : trimmed.slice(indentation(trimmed).length);
    };
    const expected = old.map(normalize);
    const positions: number[] = [];
    for (let i = eof ? Math.max(cursor, last) : cursor; i <= last; i++) {
      if (expected.every((line, offset) => line === normalize(lines[i + offset]!))) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  throw new Fail('no-match', path);
}

type OutputLine = { text: string; context?: number; noBreak?: boolean };
type Body = { old: string[]; replacement: OutputLine[] };

function readBody(lines: string[]): Body {
  const old: string[] = [];
  const replacement: OutputLine[] = [];
  let previous: OutputLine | undefined;
  for (const line of lines) {
    if (line.startsWith('\\')) {
      if (previous) previous.noBreak = true;
      previous = undefined;
      continue;
    }
    const text = line.slice(1);
    const context = line === '' || line.startsWith(' ');
    previous = undefined;
    if (context) previous = { text, context: old.length };
    else if (line.startsWith('+')) previous = { text };
    if (previous) replacement.push(previous);
    if (context || line.startsWith('-')) old.push(text);
  }
  return { old, replacement };
}

function replaceLines(lines: string[], at: number, body: Body, tier: Tier): string[] {
  const fileIndent = tier === 2 ? indentation(lines[at]!) : '';
  const patchIndent = tier === 2 ? indentation(body.old[0]!) : '';
  const replacement = body.replacement.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context]!;
    if (tier === 2 && !blank(text) && text.startsWith(patchIndent)) {
      return fileIndent + text.slice(patchIndent.length);
    }
    return text;
  });
  return [...lines.slice(0, at), ...replacement, ...lines.slice(at + body.old.length)];
}

function createLines(path: string, lines: string[], final = true): Edit {
  return (tree) => {
    checkPaths(path);
    requireAbsent(tree, path);
    tree.now.set(path, joinFile(lines, '\n', final));
  };
}

function searchEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let path: string | undefined;
  let start = 0;
  const marker = (line: string) => line.trimEnd();
  for (let i = 0; i < lines.length; i++) {
    if (marker(lines[i]!) !== '<<<<<<< SEARCH') continue;
    for (let j = i - 1; j >= start; j--) {
      const candidate = lines[j]!.trim();
      if (candidate !== '' && !candidate.startsWith('```')) {
        path = candidate;
        break;
      }
    }
    if (path === undefined) parseError(i);
    const target = path;
    const middle = lines.findIndex((line, j) => j > i && marker(line) === '=======');
    const end = lines.findIndex((line, j) => j > middle && marker(line) === '>>>>>>> REPLACE');
    if (middle < 0 || end < 0) parseError(i);
    const old = lines.slice(i + 1, middle);
    const added = lines.slice(middle + 1, end);
    if (old.length === 0) edits.push(createLines(target, added));
    else {
      const body = { old, replacement: added.map((text) => ({ text })) };
      edits.push((tree) => {
        checkPaths(target);
        const file = splitFile(requireFile(tree, target));
        const { tier, positions } = findMatches(file.lines, old, strict, target);
        if (positions.length > 1) throw new Fail('ambiguous', target);
        tree.now.set(target, joinFile(replaceLines(file.lines, positions[0]!, body, tier), file.br, file.final));
      });
    }
    i = end;
    start = end + 1;
  }
  return edits;
}

type Hunk = Body & { start: number };
type UnifiedSection = {
  fallback?: [string, string];
  paths?: [string | null, string | null];
  renameFrom?: string;
  renameTo?: string;
  create?: boolean;
  remove?: boolean;
  hunks: Hunk[];
};

function unifiedEdit(section: UnifiedSection, strict: boolean): Edit {
  const [old, next] = section.paths ?? [
    section.renameFrom ?? section.fallback![0],
    section.renameTo ?? section.fallback![1],
  ];
  return (tree) => {
    checkPaths(old, next);
    if (old === null || section.create) {
      const path = next ?? '';
      checkPaths(path);
      requireAbsent(tree, path);
      const added = section.hunks.flatMap((hunk) => hunk.replacement.filter((line) => line.context === undefined));
      tree.now.set(path, joinFile(added.map((line) => line.text), '\n', !added.at(-1)?.noBreak));
      return;
    }
    const text = requireFile(tree, old);
    if (next === null || section.remove) {
      tree.now.set(old, null);
      return;
    }
    if (old !== next) requireAbsent(tree, next);

    const file = splitFile(text);
    let delta = 0;
    for (const hunk of section.hunks) {
      let at = Math.max(0, Math.min(hunk.start + delta, file.lines.length));
      let tier: Tier = 0;
      if (hunk.old.length > 0) {
        const match = findMatches(file.lines, hunk.old, strict, old);
        tier = match.tier;
        const target = hunk.start - 1 + delta;
        at = match.positions.reduce((best, pos) =>
          Math.abs(pos - target) < Math.abs(best - target) ? pos : best);
      }
      if (at + hunk.old.length === file.lines.length) {
        file.final = !hunk.replacement.at(-1)?.noBreak;
      }
      file.lines = replaceLines(file.lines, at, hunk, tier);
      delta += hunk.replacement.length - hunk.old.length;
    }
    tree.now.set(next, joinFile(file.lines, file.br, file.final));
    if (old !== next) tree.move(old, next);
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: UnifiedSection[] = [];
  let section: UnifiedSection | undefined;
  const pairAt = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  const gitHeader = (line: string) => /^diff --git(?:\s|$)/.test(line);
  const headerPath = (line: string): string | null => {
    const path = line.slice(4).split('\t', 1)[0]!.replace(/^ +| +$/g, '');
    return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (gitHeader(line)) {
      const match = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      if (match === null) parseError(i);
      section = { fallback: [match[1]!, match[2]!], hunks: [] };
      sections.push(section);
    } else if (pairAt(i)) {
      if (section === undefined || section.paths !== undefined || section.hunks.length > 0) {
        section = { hunks: [] };
        sections.push(section);
      }
      section.paths = [headerPath(line), headerPath(lines[++i]!)];
    } else if (line.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (match === null || section === undefined) parseError(i);
      const start = i + 1;
      let end = start;
      while (end < lines.length && !pairAt(end) && !gitHeader(lines[end]!) && /^(?:[ +\\-]|$)/.test(lines[end]!)) end++;
      i = end - 1;
      while (end > start && lines[end - 1] === '') end--;
      section.hunks.push({ start: Number(match[1]), ...readBody(lines.slice(start, end)) });
    } else if (section !== undefined && section.hunks.length === 0) {
      if (line.startsWith('--- ')) parseError(i + 1);
      if (line.startsWith('rename from ')) section.renameFrom = line.slice(12);
      if (line.startsWith('rename to ')) section.renameTo = line.slice(10);
      if (/^new file mode(?: |$)/.test(line)) section.create = true;
      if (/^deleted file mode(?: |$)/.test(line)) section.remove = true;
    }
  }
  return sections.map((section) => unifiedEdit(section, strict));
}

type Chunk = { anchor: string; eof: boolean; lines: string[] };

function v4aUpdate(path: string, destination: string | undefined, chunks: Chunk[], strict: boolean): Edit {
  const bodies = chunks.map(({ anchor, eof, lines }) => ({ anchor, eof, ...readBody(lines) }));
  return (tree) => {
    checkPaths(path, destination ?? null);
    const file = splitFile(requireFile(tree, path));
    if (destination !== undefined) requireAbsent(tree, destination);
    let cursor = 0;
    for (const body of bodies) {
      if (body.anchor !== '') {
        const { positions } = findMatches(file.lines, [body.anchor], strict, path, cursor);
        cursor = positions[0]! + 1;
      }
      let at = body.eof ? file.lines.length : cursor;
      let tier: Tier = 0;
      if (body.old.length > 0) {
        const match = findMatches(file.lines, body.old, strict, path, cursor, body.eof);
        at = match.positions[0]!;
        tier = match.tier;
      }
      file.lines = replaceLines(file.lines, at, body, tier);
      cursor = at + body.replacement.length;
    }
    tree.now.set(destination ?? path, joinFile(file.lines, file.br, file.final));
    if (destination !== undefined) tree.move(path, destination);
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((line) => !blank(line));
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') parseError(Math.max(0, first));
  let last = lines.length - 1;
  while (blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') parseError(lines.length);

  const edits: Edit[] = [];
  const sectionHeader = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  for (let i = first + 1; i < last;) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const header = i;
    const match = sectionHeader.exec(lines[i++]!);
    if (match === null) parseError(header);
    const [, action, rawPath] = match;
    const path = rawPath!.trim();
    let next = i;
    while (next < last && !sectionHeader.test(lines[next]!)) next++;
    let end = next;
    while (end > i && blank(lines[end - 1]!)) end--;
    if (action === 'Add') {
      const added: string[] = [];
      for (; i < end; i++) {
        const line = lines[i]!;
        if (line !== '' && !line.startsWith('+')) parseError(i);
        added.push(line.slice(1));
      }
      edits.push(createLines(path, added));
    } else if (action === 'Delete') {
      if (i < end) parseError(i);
      edits.push((tree) => {
        checkPaths(path);
        requireFile(tree, path);
        tree.now.set(path, null);
      });
    } else {
      let destination: string | undefined;
      if (i < end && lines[i]!.startsWith('*** Move to: ')) destination = lines[i++]!.slice(13).trim();
      const chunks: Chunk[] = [];
      let chunk: Chunk | undefined;
      for (; i < end; i++) {
        const line = lines[i]!;
        if (line.startsWith('@@')) {
          chunk = { anchor: line.slice(2).trim(), eof: false, lines: [] };
          chunks.push(chunk);
        } else if (line === '*** End of File') {
          if (chunk === undefined) {
            if (chunks.length > 0) parseError(i);
            chunk = { anchor: '', eof: false, lines: [] };
            chunks.push(chunk);
          }
          chunk.eof = true;
          chunk = undefined;
        } else if (/^(?:[ +\-]|$)/.test(line)) {
          if (chunk === undefined) {
            if (chunks.length > 0) parseError(i);
            chunk = { anchor: '', eof: false, lines: [] };
            chunks.push(chunk);
          }
          chunk.lines.push(line);
        } else parseError(i);
      }
      if (chunks.length === 0 && destination === undefined) parseError(header);
      edits.push(v4aUpdate(path, destination, chunks, strict));
    }
    i = next;
  }
  return edits;
}

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
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = searchEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      tree.moves.length = moveCount;
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: string[] = [];
  const renamedFrom = new Set<string>();
  const renamedTo = new Map<string, string>();
  for (const [old, next] of tree.moves) {
    if (renamedFrom.has(old) || renamedTo.has(next)) continue;
    if (tree.original(old) !== null && tree.get(old) === null &&
        tree.original(next) === null && tree.get(next) !== null) {
      renamedFrom.add(old);
      renamedTo.set(next, old);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const old = renamedTo.get(p);
    if (old !== undefined) rows.push(`R ${old} -> ${p}`);
    else if (!renamedFrom.has(p)) rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
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
