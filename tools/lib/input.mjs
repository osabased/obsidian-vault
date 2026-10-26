import fs from 'node:fs';

export class UsageError extends Error {}
export class Refused extends Error {}

export function readInput() {
  let p;
  try { p = JSON.parse(fs.readFileSync(0, 'utf8').replace(/^﻿/, '')); } catch { throw new UsageError(); }
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new UsageError();
  return p;
}

export const refuser = prefix => msg => { throw new Refused(`${prefix}: ${msg}`); };

// lib/ doesn't print, so each script prints the message and sets the exit code this returns.
export function failure(e, name, usage) {
  if (e instanceof UsageError) return { message: usage, code: 2 };
  if (e instanceof Refused) return { message: e.message, code: 1 };
  return { message: `${name} failed: ${e.message}`, code: 1 };
}

export function line(refuse, p, name, required = true) {
  const v = p[name] ?? '';
  if (typeof v !== 'string') refuse(`${name} must be a string.`);
  if (required && !v.trim()) refuse(`${name} is missing.`);
  if (/[\r\n]/.test(v.trim())) refuse(`${name} must be one line.`);
  return v.trim();
}
