import fs from 'node:fs';

export class UsageError extends Error {}
export class Refused extends Error {}

// The parser's reason names where the JSON broke, as when a shell halved a backslash, which the usage alone hides.
export function readInput() {
  let text;
  try { text = fs.readFileSync(0, 'utf8').replace(/^﻿/, ''); } catch (e) { throw new UsageError(`Couldn't read stdin: ${e.message}.`); }
  if (!text.trim()) throw new UsageError('No JSON came on stdin.');
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new UsageError(`The input isn't valid JSON: ${e.message}.`); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new UsageError('The input must be one JSON object.');
  return p;
}

export const refuse = msg => { throw new Refused(msg); };

// lib/ doesn't print, so each script prints the message and sets the exit code this returns.
export function failure(e, name, usage, refused = 'Refused') {
  if (e instanceof UsageError) return { message: e.message ? `${e.message}\n${usage}` : usage, code: 2 };
  if (e instanceof Refused) return { message: `${refused}: ${e.message}`, code: 1 };
  return { message: `${name} failed: ${e.message}`, code: 1 };
}

// What a shell makes of a backslash escape such as \b or \t. Line breaks have their own check.
export const CONTROL = /[\u0000-\u0009\u000B\u000C\u000E-\u001F\u007F-\u009F]/;

function noControl(v, name) {
  const c = CONTROL.exec(v)?.[0];
  if (c) refuse(`${name} holds a control character, U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}, which a shell makes of a backslash escape. Send it through the vault's tools, which pass it exactly.`);
}

export function line(p, name, required = true) {
  const v = p[name] ?? '';
  if (typeof v !== 'string') refuse(`${name} must be a string.`);
  if (required && !v.trim()) refuse(`${name} is missing.`);
  if (/[\r\n]/.test(v.trim())) refuse(`${name} must be one line.`);
  noControl(v.trim(), name);
  return v.trim();
}

export function lines(p, name) {
  const v = p[name] ?? [];
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string' || !x.trim() || /[\r\n]/.test(x))) refuse(`${name} must be a list of one-line strings.`);
  for (const x of v) noControl(x, name);
  return v.map(x => x.trim());
}

// A fields list describes a script's input once, for its --help and its --schema. An entry is one of:
//   { name, type, help?, label?, indent?, describe?, enum?, items?, required? }  a property; type is 'string', 'boolean',
//     'number', 'string[]' or 'object[]'. Its help shows as a row when it has lines.
//   { label, help, indent? }  a row of help that is no property, such as a value of another field.
//   { text: [line, ...] }  lines printed as they are.
// A row is two spaces, indent spaces, the label (name when none) padded to the label width, then the help; a label too
// wide for the width keeps two spaces after it. Continuation lines sit under the first and carry any extra leading
// spaces they are given. describe replaces the joined help as the property's description.
const lineList = x => (Array.isArray(x) ? x : x === undefined ? [] : String(x).split('\n'));

export function renderHelp(head, fields, tail, width) {
  const out = [...lineList(head)];
  for (const f of fields) {
    if (f.text) { out.push(...f.text); continue; }
    const label = f.label ?? f.name;
    if (!f.help?.length || label === undefined) continue;
    const lead = ' '.repeat(2 + (f.indent ?? 0));
    const col = Math.max(width, label.length + 2);
    out.push(`${lead}${label.padEnd(col)}${f.help[0]}`);
    for (const l of f.help.slice(1)) out.push(`${lead}${' '.repeat(col)}${l}`);
  }
  out.push(...lineList(tail));
  return out.join('\n');
}

function propertyOf(f) {
  const list = f.type.endsWith('[]');
  const kind = list ? f.type.slice(0, -2) : f.type;
  const p = list ? { type: 'array', items: f.items ?? { type: kind } } : { type: kind };
  if (f.enum) p.enum = f.enum;
  const description = f.describe ?? f.help?.map(l => l.trim()).join(' ');
  if (description) p.description = description;
  return p;
}

export function schemaOf(summary, fields) {
  const named = fields.filter(f => f.name && f.type);
  return {
    description: summary,
    inputSchema: {
      type: 'object',
      properties: Object.fromEntries(named.map(f => [f.name, propertyOf(f)])),
      required: named.filter(f => f.required).map(f => f.name),
      additionalProperties: false,
    },
  };
}

// '--schema' alone asks for the prompt variant. The variant is the consent a tool's text is written for.
export function schemaArg(argv) {
  if (argv[0] !== '--schema') return null;
  const variant = argv[1] ?? 'prompt';
  if (argv.length > 2 || !['prompt', 'code'].includes(variant)) throw new UsageError('--schema takes prompt or code.');
  return variant;
}
