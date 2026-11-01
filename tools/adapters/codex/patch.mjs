// Reads apply_patch's input as Codex reads it (codex-rs/apply-patch, parser.rs and seek_sequence.rs, rust-v0.153.4), so the
// edit hook gates the same files and tests the same new text Codex will write. Pure: no file is read here.

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ENV = '*** Environment ID:';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const EOF_MARK = '*** End of File';

const fail = msg => { throw new Error(`invalid patch: ${msg}`); };

// Codex retries a patch the model wrapped in a heredoc, as a shell would have read it.
function body(text) {
  const lines = String(text).trim().split('\n').map(l => l.replace(/\r$/, ''));
  const framed = ls => ls.length >= 2 && ls[0].trim() === BEGIN && ls.at(-1).trim() === END;
  if (framed(lines)) return lines.slice(1, -1);
  if (lines.length >= 4 && /^<<(?:EOF|'EOF'|"EOF")$/.test(lines[0]) && lines.at(-1).endsWith('EOF') && framed(lines.slice(1, -1))) {
    return lines.slice(2, -2);
  }
  return fail(lines[0]?.trim() === BEGIN ? `the last line must be '${END}'` : `the first line must be '${BEGIN}'`);
}

// The + lines of each chunk, which the chunk's old and new lines alone can't tell from its context lines.
const PLUS = new WeakMap();
const newChunk = context => {
  const c = { context, old: [], new: [], eof: false };
  PLUS.set(c, []);
  return c;
};

// The text a patch adds to its file: an added file's content, or an update's + lines.
export function addedText(op) {
  if (op.op === 'add') return op.lines.join('\n');
  if (op.op === 'delete') return '';
  return op.chunks.flatMap(c => PLUS.get(c) ?? []).join('\n');
}

const headerPath = (line, marker) => (line.startsWith(marker) ? line.slice(marker.length).trim() : null);

// [{ op: 'add', path, lines }, { op: 'delete', path }, { op: 'update', path, moveTo?, chunks: [{ context, old, new, eof }] }]
export function parsePatch(text) {
  const lines = body(text);
  const ops = [];
  let cur = null;
  const lineNo = i => i + 2;
  const closeUpdate = () => {
    if (cur?.op !== 'update') return;
    if (!cur.chunks.length) fail(`Update file hunk for path '${cur.path}' is empty`);
    const last = cur.chunks.at(-1);
    if (!last.old.length && !last.new.length) fail(`Update file hunk for path '${cur.path}' is empty`);
  };
  const header = (line, i) => {
    const t = line.trim();
    let p;
    if ((p = headerPath(t, ADD)) !== null) cur = { op: 'add', path: p, lines: [] };
    else if ((p = headerPath(t, DELETE)) !== null) cur = { op: 'delete', path: p };
    else if ((p = headerPath(t, UPDATE)) !== null) cur = { op: 'update', path: p, chunks: [] };
    else if (t.startsWith(ENV)) {
      if (i !== 0 || ops.length || cur) fail(`'${ENV}' is allowed only on the line after '${BEGIN}'`);
      if (!t.slice(ENV.length).trim()) fail(`'${ENV}' is empty`);
      return true;
    } else return false;
    if (!cur.path) fail(`line ${lineNo(i)} names no file`);
    ops.push(cur);
    return true;
  };
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (cur?.op === 'update') {
      const t = raw.trimEnd();
      const isHeader = [ADD, DELETE, UPDATE].some(m => t.startsWith(m)) || t.startsWith(ENV);
      if (isHeader) {
        closeUpdate();
        header(raw, i);
        continue;
      }
      if (t.startsWith(MOVE)) {
        if (cur.chunks.length) fail(`line ${lineNo(i)}: '${MOVE.trim()}' must come before the first chunk`);
        cur.moveTo = t.slice(MOVE.length).trim();
        continue;
      }
      const last = cur.chunks.at(-1);
      const empty = c => !c.old.length && !c.new.length;
      if (t === '@@' || t.startsWith('@@ ')) {
        if (last && empty(last)) fail(`line ${lineNo(i)}: Update file hunk for path '${cur.path}' has an empty chunk`);
        cur.chunks.push(newChunk(t === '@@' ? null : t.slice(3)));
        continue;
      }
      if (t === EOF_MARK) {
        if (!last || empty(last)) fail(`line ${lineNo(i)}: Update file hunk for path '${cur.path}' has an empty chunk before '${EOF_MARK}'`);
        last.eof = true;
        continue;
      }
      if (last?.eof) {
        if (!raw.trim()) continue;
        fail(`invalid patch hunk at line ${lineNo(i)}, expected '@@' after '${EOF_MARK}', got '${raw}'`);
      }
      const chunk = last ?? (cur.chunks.push(newChunk(null)), cur.chunks.at(-1));
      if (raw === '') { chunk.old.push(''); chunk.new.push(''); continue; }
      const [sign, rest] = [raw[0], raw.slice(1)];
      if (sign === ' ') { chunk.old.push(rest); chunk.new.push(rest); } else if (sign === '+') { chunk.new.push(rest); PLUS.get(chunk).push(rest); }
      else if (sign === '-') chunk.old.push(rest);
      else fail(`invalid patch hunk at line ${lineNo(i)}, '${raw}' is not a change line in the update of '${cur.path}'`);
      continue;
    }
    if (header(raw, i)) continue;
    if (cur?.op === 'add' && raw.startsWith('+')) { cur.lines.push(raw.slice(1)); continue; }
    fail(`invalid patch hunk at line ${lineNo(i)}, '${raw}' is not a valid hunk header`);
  }
  closeUpdate();
  return ops;
}

const ODD = [
  [/[\u2010-\u2015\u2212]/g, '-'],
  [/[\u2018-\u201B]/g, "'"],
  [/[\u201C-\u201F]/g, '"'],
  [/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, ' '],
];
const normalized = s => ODD.reduce((t, [re, to]) => t.replace(re, to), s.trim());
const PASSES = [s => s, s => s.trimEnd(), s => s.trim(), normalized];

function seek(lines, pattern, start, eof) {
  if (!pattern.length) return start;
  if (pattern.length > lines.length) return null;
  const from = eof ? lines.length - pattern.length : start;
  for (const f of PASSES) {
    for (let i = from; i <= lines.length - pattern.length; i++) {
      if (pattern.every((p, j) => f(lines[i + j]) === f(p))) return i;
    }
  }
  return null;
}

// The file's text after the chunks, or null when a chunk isn't found, which Codex refuses.
export function applyChunks(text, chunks) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const swaps = [];
  let idx = 0;
  for (const c of chunks) {
    if (c.context !== null) {
      const at = seek(lines, [c.context], idx, false);
      if (at === null) return null;
      idx = at + 1;
    }
    if (!c.old.length) {
      swaps.push([lines.at(-1) === '' ? lines.length - 1 : lines.length, 0, c.new]);
      continue;
    }
    let [old, add] = [c.old, c.new];
    let at = seek(lines, old, idx, c.eof);
    if (at === null && old.at(-1) === '') {
      old = old.slice(0, -1);
      if (add.at(-1) === '') add = add.slice(0, -1);
      at = seek(lines, old, idx, c.eof);
    }
    if (at === null) return null;
    swaps.push([at, old.length, add]);
    idx = at + old.length;
  }
  for (const [at, n, add] of swaps.sort((a, b) => b[0] - a[0])) lines.splice(at, n, ...add);
  if (lines.at(-1) !== '') lines.push('');
  return lines.join('\n');
}
