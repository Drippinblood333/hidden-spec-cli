import { mkdirSync, readFileSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

type Failure = 'unsafe' | 'exists' | 'missing' | 'no-match' | 'ambiguous';
type Edit = {
  paths: string[];
  source?: string;
  target?: string;
  moving?: boolean;
  apply: (before: string) => string | FailureResult;
};
type FailureResult = { failure: Failure };
type FileLines = { lines: string[]; br: string; final: boolean };
type Body = { old: string[]; next: { text: string; context?: number }[] };
type Match = { tier: number; positions: number[] };

class ParseFault extends Error {
  constructor(line: number) { super(`parse ${line}`); }
}

function patchLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map(line => line.replace(/\r$/, ''));
}

function splitFile(text: string): FileLines {
  const br = text[text.indexOf('\n') - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const lines = text ? text.split(br) : [];
  if (final) lines.pop();
  return { lines, br, final };
}

function joinFile({ lines, br, final }: FileLines): string {
  return lines.length ? lines.join(br) + (final ? br : '') : '';
}

function created(lines: string[], final = true): string {
  return joinFile({ lines, br: '\n', final });
}

function safe(path: string): boolean {
  return !path.includes('\\') && !path.includes('\0') &&
    path.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function normalize(line: string, tier: number): string {
  if (tier === 0) return line;
  const trimmed = line.replace(/[ \t]+$/, '');
  return tier === 2 ? trimmed.replace(/^[ \t]+/, '') : trimmed;
}

function match(lines: string[], old: string[], strict: boolean, start = 0, eof = false): Match | undefined {
  const last = lines.length - old.length;
  for (let tier = 0; tier <= (strict ? 0 : 2); tier++) {
    const wanted = old.map(line => normalize(line, tier));
    const positions: number[] = [];
    for (let i = eof ? Math.max(start, last) : start; i <= last; i++) {
      if (wanted.every((line, j) => line === normalize(lines[i + j], tier))) positions.push(i);
    }
    if (positions.length) return { tier, positions };
  }
}

function replace(lines: string[], at: number, body: Body, tier: number): string[] {
  const prefix = (line: string) => line.match(/^[ \t]*/)?.[0] ?? '';
  const from = tier === 2 ? prefix(body.old[0]) : '';
  const to = tier === 2 ? prefix(lines[at]) : '';
  const next = body.next.map(({ text, context }) => {
    if (context !== undefined) return lines[at + context];
    return tier === 2 && text.trim() && text.startsWith(from) ? to + text.slice(from.length) : text;
  });
  return lines.slice(0, at).concat(next, lines.slice(at + body.old.length));
}

function readBody(lines: string[]): Body {
  const body: Body = { old: [], next: [] };
  for (const line of lines) {
    const text = line.slice(1);
    if (line.startsWith('+')) body.next.push({ text });
    else if (line.startsWith('-')) body.old.push(text);
    else if (line === '' || line.startsWith(' ')) {
      body.next.push({ text, context: body.old.length });
      body.old.push(text);
    }
  }
  return body;
}

function edit(source: string | undefined, target: string | undefined, apply: Edit['apply'],
  paths = [source, target].filter((path): path is string => path !== undefined)): Edit {
  return { source, target, apply, paths };
}

type Hunk = { at: number; raw: string[] };
type Section = {
  fallback?: [string, string];
  pair?: [string | null, string | null];
  from?: string;
  to?: string;
  add?: boolean;
  del?: boolean;
  hunks: Hunk[];
};

function unifiedPath(raw: string): string | null {
  const path = raw.split('\t', 1)[0].trim();
  return path === '/dev/null' ? null : path.replace(/^[ab]\//, '');
}

function unifiedEdit(section: Section): Edit {
  const source = section.pair ? section.pair[0] ?? undefined : section.from ?? section.fallback?.[0];
  const target = section.pair ? section.pair[1] ?? undefined : section.to ?? section.fallback?.[1];
  const paths = [source, target].filter((path): path is string => path !== undefined);
  if (section.add || source === undefined) {
    const raw = section.hunks.flatMap(hunk => hunk.raw);
    const last = raw.findLastIndex(line => line.startsWith('+'));
    return edit(undefined, target, () =>
      created(raw.filter(line => line.startsWith('+')).map(line => line.slice(1)),
        last < 0 || !raw[last + 1]?.startsWith('\\')), paths);
  }
  if (section.del || target === undefined) return edit(source, undefined, () => '', paths);
  return edit(source, target, before => {
    const file = splitFile(before);
    let delta = 0;
    for (const { at, raw } of section.hunks) {
      const body = readBody(raw);
      let position = Math.max(0, Math.min(file.lines.length, at + delta));
      let tier = 0;
      if (body.old.length) {
        const found = match(file.lines, body.old, strictMatching);
        if (!found) return { failure: 'no-match' };
        tier = found.tier;
        const expected = at - 1 + delta;
        position = found.positions.reduce((best, candidate) =>
          Math.abs(candidate - expected) < Math.abs(best - expected) ? candidate : best);
      }
      if (position + body.old.length === file.lines.length) {
        const last = raw.findLastIndex(line => line === '' || /^[ +]/.test(line));
        file.final = last < 0 || !raw[last + 1]?.startsWith('\\');
      }
      file.lines = replace(file.lines, position, body, tier);
      delta += body.next.length - body.old.length;
    }
    return joinFile(file);
  }, paths);
}

function parseUnified(lines: string[]): Edit[] {
  const sections: Section[] = [];
  let section: Section | undefined;
  let inHeader = false;
  const start = (fallback?: [string, string]) => {
    section = { fallback, hunks: [] };
    sections.push(section);
    inHeader = true;
  };
  const pairAt = (i: number) => lines[i]?.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ');
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^diff --git(?:\s|$)/.test(line)) {
      const names = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (!names) throw new ParseFault(i + 1);
      start([names[1], names[2]]);
    } else if (pairAt(i)) {
      if (!section || !inHeader || section.pair) start();
      section!.pair = [unifiedPath(line.slice(4)), unifiedPath(lines[++i].slice(4))];
    } else if (line.startsWith('@@')) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      if (!header || !section) throw new ParseFault(i + 1);
      inHeader = false;
      const raw: string[] = [];
      i++;
      while (i < lines.length && !pairAt(i) && (lines[i] === '' || /^[ +\\-]/.test(lines[i]))) {
        raw.push(lines[i++]);
      }
      while (raw.at(-1) === '') raw.pop();
      section.hunks.push({ at: Number(header[1]), raw });
      continue;
    } else if (section && inHeader) {
      if (line.startsWith('--- ')) throw new ParseFault(i + 2);
      if (line.startsWith('rename from ')) section.from = line.slice(12).trim();
      if (line.startsWith('rename to ')) section.to = line.slice(10).trim();
      if (line.startsWith('new file mode ')) section.add = true;
      if (line.startsWith('deleted file mode ')) section.del = true;
    }
    i++;
  }
  return sections.map(unifiedEdit);
}

let strictMatching = false;

function parseSearch(lines: string[]): Edit[] {
  const edits: Edit[] = [];
  let previousPath: string | undefined;
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== '<<<<<<< SEARCH') continue;
    const path = lines.slice(start, i).map(line => line.trim())
      .findLast(line => line && !line.startsWith('```')) ?? previousPath;
    const separator = lines.findIndex((line, j) => j > i && line.trimEnd() === '=======');
    const end = lines.findIndex((line, j) => j > separator && line.trimEnd() === '>>>>>>> REPLACE');
    if (path === undefined || separator < 0 || end < 0) throw new ParseFault(i + 1);
    const old = lines.slice(i + 1, separator);
    const next = lines.slice(separator + 1, end);
    edits.push(edit(old.length ? path : undefined, path, before => {
      if (!old.length) return created(next);
      const file = splitFile(before);
      const found = match(file.lines, old, strictMatching);
      if (!found) return { failure: 'no-match' };
      if (found.positions.length > 1) return { failure: 'ambiguous' };
      file.lines = replace(file.lines, found.positions[0], { old, next: next.map(text => ({ text })) }, found.tier);
      return joinFile(file);
    }));
    previousPath = path;
    start = end + 1;
    i = end;
  }
  return edits;
}

function parseJson(lines: string[]): Edit[] {
  const first = lines.findIndex(line => line.trim());
  if (first < 0) return [];
  const decode = (text: string, line: number): unknown => {
    try { return JSON.parse(text); }
    catch { throw new ParseFault(line); }
  };
  const read = (value: unknown, line: number): Edit => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ParseFault(line);
    const { command, path, file_text, old_str, new_str, insert_line } = value as Record<string, unknown>;
    if (typeof path !== 'string') throw new ParseFault(line);
    if (command === 'create' && typeof file_text === 'string') {
      return edit(undefined, path, () => file_text);
    }
    if (command === 'str_replace' && typeof old_str === 'string' && old_str &&
      (new_str === undefined || typeof new_str === 'string')) {
      return edit(path, path, before => {
        const { br } = splitFile(before);
        const normalizeBreaks = (text: string) => br === '\r\n' ? text.replaceAll('\r\n', '\n') : text;
        const text = normalizeBreaks(before);
        const old = normalizeBreaks(old_str);
        const at = text.indexOf(old);
        if (at < 0) return { failure: 'no-match' };
        if (text.indexOf(old, at + 1) !== -1) return { failure: 'ambiguous' };
        const result = text.slice(0, at) + normalizeBreaks(new_str ?? '') + text.slice(at + old.length);
        return br === '\r\n' ? result.replaceAll('\n', br) : result;
      });
    }
    if (command === 'insert' && typeof insert_line === 'number' && Number.isInteger(insert_line) &&
      typeof new_str === 'string') {
      return edit(path, path, before => {
        const file = splitFile(before);
        if (insert_line < 0 || insert_line > file.lines.length) return { failure: 'no-match' };
        file.lines = file.lines.slice(0, insert_line).concat(patchLines(new_str), file.lines.slice(insert_line));
        return joinFile(file);
      });
    }
    throw new ParseFault(line);
  };
  if (lines[first].trimStart().startsWith('[')) {
    const array = decode(lines.join('\n'), first + 1);
    if (!Array.isArray(array)) throw new ParseFault(first + 1);
    return array.map(value => read(value, first + 1));
  }
  return lines.flatMap((text, i) => text.trim() ? [read(decode(text, i + 1), i + 1)] : []);
}

const parsers = { unified: parseUnified, 'search-replace': parseSearch, v4a: parseV4a, json: parseJson };
type Format = keyof typeof parsers;

function detect(lines: string[]): Format | undefined {
  const first = lines.find(line => line.trim())?.trim();
  if (first === '*** Begin Patch') return 'v4a';
  if (first?.startsWith('[') || first?.startsWith('{')) return 'json';
  if (lines.some(line => line.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((line, i) => line.startsWith('diff --git ') ||
    (line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')))) return 'unified';
}

function run(args: string[]): { code: number; out: string[] } {
  const error = (message: string) => ({ code: 2, out: [`error: ${message}`] });
  const options = new Set<string>();
  let format: Format | 'auto' = 'auto';
  let patch: string | undefined;
  let positional = false;
  for (const arg of args) {
    if (!positional && arg === '--') positional = true;
    else if (!positional && arg.startsWith('-') && arg !== '-') {
      const name = arg.startsWith('--format=') ? '--format' : arg;
      if (options.has(name)) return error('usage');
      if (name === '--format' && arg.startsWith('--format=')) {
        const value = arg.slice(9);
        if (value !== 'auto' && !Object.hasOwn(parsers, value)) return error('usage');
        format = value as typeof format;
      } else if (name !== '--check' && name !== '--strict') return error('usage');
      options.add(name);
    } else {
      if (patch !== undefined) return error('usage');
      patch = arg;
    }
  }
  strictMatching = options.has('--strict');
  let lines: string[];
  try { lines = patchLines(readFileSync(patch === undefined || patch === '-' ? 0 : patch, 'utf8')); }
  catch { return error('no-patch'); }
  const selected = format === 'auto' ? detect(lines) : format;
  if (!selected) return error('format');
  let edits: Edit[];
  try { edits = parsers[selected](lines); }
  catch (fault) {
    if (fault instanceof ParseFault) return error(fault.message);
    throw fault;
  }
  if (!edits.length) return error('parse 1');

  const original = new Map<string, string | undefined>();
  const current = new Map<string, string | undefined>();
  const moves: [string, string][] = [];
  const failures: string[] = [];
  const get = (path: string) => {
    if (!current.has(path)) {
      let value: string | undefined;
      try { value = readFileSync(path, 'utf8'); }
      catch (fault) {
        if (!['ENOENT', 'ENOTDIR', 'EISDIR'].includes((fault as NodeJS.ErrnoException).code ?? '')) throw fault;
      }
      original.set(path, value);
      current.set(path, value);
    }
    return current.get(path);
  };
  for (const { paths, source, target, apply, moving } of edits) {
    const unsafe = paths.find(path => !safe(path));
    const fail = (code: Failure, path: string) => failures.push(`error: ${code} ${path}`);
    if (unsafe !== undefined) {
      fail('unsafe', unsafe);
      continue;
    }
    const before = source === undefined ? undefined : get(source);
    if (source !== undefined && before === undefined) {
      fail('missing', source);
      continue;
    }
    if (target !== undefined && (target !== source || moving) && get(target) !== undefined) {
      fail('exists', target);
      continue;
    }
    const result = apply(before ?? '');
    if (typeof result !== 'string') {
      fail(result.failure, source!);
      continue;
    }
    if (source !== undefined && source !== target) current.set(source, undefined);
    if (target !== undefined) current.set(target, result);
    if (source !== undefined && target !== undefined && source !== target) moves.push([source, target]);
  }
  if (failures.length) return { code: 1, out: [...failures, `failed: ${failures.length} of ${edits.length} edits`] };

  const changes = new Map<string, string>();
  for (const [path, after] of current) {
    const before = original.get(path);
    if (after === before) continue;
    changes.set(path, `${after === undefined ? 'D' : before === undefined ? 'A' : 'M'} ${path}`);
  }
  if (!options.has('--check')) {
    for (const path of changes.keys()) {
      if (current.get(path) === undefined) unlinkSync(path);
    }
    for (const path of changes.keys()) {
      const after = current.get(path);
      if (after === undefined) continue;
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, after);
    }
  }
  for (const [source, target] of moves) {
    if (changes.get(source) === `D ${source}` && changes.get(target) === `A ${target}`) {
      changes.delete(source);
      changes.set(target, `R ${source} -> ${target}`);
    }
  }
  const out = [...changes.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
    .map(path => changes.get(path)!);
  out.push(`ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`);
  return { code: 0, out };
}

type Chunk = { anchor: string; body: Body; eof: boolean };

function applyChunks(before: string, chunks: Chunk[]): string | FailureResult {
  const file = splitFile(before);
  let cursor = 0;
  for (const { anchor, body, eof } of chunks) {
    if (anchor) {
      const found = match(file.lines, [anchor], strictMatching, cursor);
      if (!found) return { failure: 'no-match' };
      cursor = found.positions[0] + 1;
    }
    let position = eof ? file.lines.length : cursor;
    let tier = 0;
    if (body.old.length) {
      const found = match(file.lines, body.old, strictMatching, cursor, eof);
      if (!found) return { failure: 'no-match' };
      position = found.positions[0];
      tier = found.tier;
    }
    file.lines = replace(file.lines, position, body, tier);
    cursor = position + body.next.length;
  }
  return joinFile(file);
}

function parseV4a(lines: string[]): Edit[] {
  const first = lines.findIndex(line => line.trim());
  const last = lines.findLastIndex(line => line.trim());
  if (first < 0 || lines[first].trim() !== '*** Begin Patch') throw new ParseFault(Math.max(1, first + 1));
  if (lines[last].trim() !== '*** End Patch') throw new ParseFault(lines.length + 1);
  const header = /^\*\*\* (Add|Delete|Update) File: (.*)$/;
  const edits: Edit[] = [];
  for (let i = first + 1; i < last;) {
    if (!lines[i].trim()) {
      i++;
      continue;
    }
    const sectionLine = i + 1;
    const section = header.exec(lines[i++]);
    if (!section) throw new ParseFault(sectionLine);
    const [, kind, name] = section;
    const path = name.trim();
    let end = i;
    while (end < last && !header.test(lines[end])) end++;
    const following = end;
    while (end > i && !lines[end - 1].trim()) end--;
    if (kind === 'Add') {
      const contents: string[] = [];
      for (; i < end; i++) {
        if (lines[i] && !lines[i].startsWith('+')) throw new ParseFault(i + 1);
        contents.push(lines[i].slice(1));
      }
      edits.push(edit(undefined, path, () => created(contents)));
    } else if (kind === 'Delete') {
      if (i < end) throw new ParseFault(i + 1);
      edits.push(edit(path, undefined, () => ''));
    } else {
      let target = path;
      const moving = i < end && lines[i].startsWith('*** Move to: ');
      if (moving) target = lines[i++].slice(13).trim();
      const chunks: Chunk[] = [];
      while (i < end) {
        let anchor = '';
        if (lines[i].startsWith('@@')) anchor = lines[i++].slice(2).trim();
        else if (chunks.length || (lines[i] !== '' && !/^[ +-]/.test(lines[i]))) throw new ParseFault(i + 1);
        const raw: string[] = [];
        while (i < end && (lines[i] === '' || /^[ +-]/.test(lines[i]))) raw.push(lines[i++]);
        const eof = i < end && lines[i] === '*** End of File';
        if (eof) i++;
        chunks.push({ anchor, body: readBody(raw), eof });
      }
      if (!moving && !chunks.length) throw new ParseFault(sectionLine);
      edits.push({ ...edit(path, target, before => applyChunks(before, chunks)), moving });
    }
    i = following;
  }
  return edits;
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
