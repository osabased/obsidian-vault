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

export function line(p, name, required = true) {
  const v = p[name] ?? '';
  if (typeof v !== 'string') refuse(`${name} must be a string.`);
  if (required && !v.trim()) refuse(`${name} is missing.`);
  if (/[\r\n]/.test(v.trim())) refuse(`${name} must be one line.`);
  return v.trim();
}
