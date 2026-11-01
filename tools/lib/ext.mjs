import fs from 'node:fs';
import { createRequire } from 'node:module';
import { toolsPath } from './vault.mjs';

// Code one interface needs per format lives in tools/ext/<type>/<name>.mjs, and config names it, so the core names no
// format, tool or domain.
export const EXTENSION_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const extensionRel = (type, name) => `tools/ext/${type}/${name}.mjs`;

// Hooks run synchronously, and require loads an ES module synchronously from Node 22.12 on.
const load = createRequire(import.meta.url);

// How tools/ finds a module by a name config or the user gives: extensions, adapters and compile formats. The name check
// keeps a name from climbing out of its folder. Each caller words its own error for a name that has no module.
export function byName(fileOf) {
  return { has: name => typeof name === 'string' && EXTENSION_NAME.test(name) && fs.existsSync(fileOf(name)), load: name => load(fileOf(name)) };
}

const ofType = type => byName(name => toolsPath('ext', type, `${name}.mjs`));
export const hasExtension = (type, name) => ofType(type).has(name);

export function extension(type, name, exports) {
  if (!hasExtension(type, name)) throw new Error(`${extensionRel(type, name)} doesn't exist`);
  const mod = ofType(type).load(name);
  const missing = exports.filter(e => typeof mod[e] !== 'function');
  if (missing.length) throw new Error(`${extensionRel(type, name)} exports no ${missing.join(' or ')} function`);
  return mod;
}
