// Edits to a JSON file the user also edits by hand, such as vault.local.json, that leave every byte outside the edit
// as it was.

// Scalars and lists of scalars stay on one line, as the vault's config writes them; an object takes a line per key.
function jsonText(value, unit, eol, depth) {
  const scalars = Array.isArray(value) && value.every(x => x === null || typeof x !== 'object');
  if (value === null || typeof value !== 'object' || scalars) return Array.isArray(value) ? `[${value.map(x => JSON.stringify(x)).join(', ')}]` : JSON.stringify(value);
  const pad = unit.repeat(depth + 1);
  const items = Array.isArray(value) ? value.map(x => `${pad}${jsonText(x, unit, eol, depth + 1)}`)
    : Object.entries(value).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${jsonText(x, unit, eol, depth + 1)}`);
  const [open, close] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];
  return items.length ? `${open}${eol}${items.join(`,${eol}`)}${eol}${unit.repeat(depth)}${close}` : `${open}${close}`;
}

function stringEnd(s, i) {
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '"') return j + 1;
  }
  throw new Error('a string in the JSON never ends');
}

function closing(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '"') j = stringEnd(s, j) - 1;
    else if (s[j] === '{' || s[j] === '[') depth++;
    else if ((s[j] === '}' || s[j] === ']') && --depth === 0) return j;
  }
  throw new Error('a bracket in the JSON never closes');
}

// Where the value of each key of the object whose brace is at i starts.
export function valuesOf(s, i) {
  const at = new Map();
  const end = closing(s, i);
  for (let j = i + 1; j < end;) {
    if (s[j] !== '"') { j++; continue; }
    const keyEnd = stringEnd(s, j);
    const key = JSON.parse(s.slice(j, keyEnd));
    let v = keyEnd;
    while (/[\s:]/.test(s[v])) v++;
    at.set(key, v);
    j = s[v] === '{' || s[v] === '[' ? closing(s, v) + 1 : s[v] === '"' ? stringEnd(s, v) : v + 1;
  }
  return at;
}

// The file's own indent unit and line ends, so a written member looks like the user's.
const layout = text => ({ eol: text.includes('\r\n') ? '\r\n' : '\n', unit: /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ' });

// The text with key added as the last member of the object whose brace is at open, in the file's own indent and line
// ends; every other byte stays as it was, so the user's layout, and a BOM, survive.
export function addMember(text, open, depth, key, value) {
  const { eol, unit } = layout(text);
  const close = closing(text, open);
  let last = close - 1;
  while (/\s/.test(text[last])) last--;
  const empty = last === open;
  const member = `${empty ? '' : ','}${eol}${unit.repeat(depth)}${JSON.stringify(key)}: ${jsonText(value, unit, eol, depth)}${empty ? `${eol}${unit.repeat(depth - 1)}` : ''}`;
  return text.slice(0, last + 1) + member + text.slice(last + 1);
}

// Where the value starting at i ends.
function valueEnd(s, i) {
  if (s[i] === '{' || s[i] === '[') return closing(s, i) + 1;
  if (s[i] === '"') return stringEnd(s, i);
  let j = i;
  while (j < s.length && !/[\s,}\]]/.test(s[j])) j++;
  return j;
}

// The text with key set to value in the object whose brace is at open: a value it has is replaced where it stands, and a
// key it lacks is added as addMember adds it.
export function setMember(text, open, depth, key, value) {
  const at = valuesOf(text, open).get(key);
  if (at === undefined) return addMember(text, open, depth, key, value);
  const { eol, unit } = layout(text);
  return text.slice(0, at) + jsonText(value, unit, eol, depth) + text.slice(valueEnd(text, at));
}

// The text with the value at keys set as setMember sets it, adding each object on the way that the file lacks; null when
// the file holds no object, or a key on the way holds something else.
export function setIn(text, keys, value) {
  let open = text.indexOf('{');
  if (open < 0) return null;
  for (let i = 0; i < keys.length - 1; i++) {
    const at = valuesOf(text, open).get(keys[i]);
    if (at === undefined) return addMember(text, open, i + 1, keys[i], keys.slice(i + 1).reduceRight((v, k) => ({ [k]: v }), value));
    if (text[at] !== '{') return null;
    open = at;
  }
  return setMember(text, open, keys.length, keys.at(-1), value);
}
