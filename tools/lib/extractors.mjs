import { EXTENSION_NAME, hasExtension, extensionRel, extension } from './ext.mjs';
import { KINDS } from './sources.mjs';
import { joinList } from './rules.mjs';

const EXTENSION = /^\.[a-z0-9][a-z0-9._-]*$/;

// An extractor as extract.mjs runs it, loaded as a hook loads an extension, or the problems that keep it from running,
// each as lint reports it.
export function loadExtractor(name) {
  if (typeof name !== 'string' || !EXTENSION_NAME.test(name)) return { problems: [`extractors: ${JSON.stringify(name)} must name an extension in lowercase letters, digits, - or _`] };
  const rel = extensionRel('extractors', name);
  if (!hasExtension('extractors', name)) return { problems: [`extractors names ${name}, and ${rel} doesn't exist`] };
  let mod;
  try {
    mod = extension('extractors', name, ['extract']);
  } catch (e) {
    return { problems: [`extractors: ${name}: ${e.message}`] };
  }
  const problems = [];
  if (!Array.isArray(mod.kinds) || !mod.kinds.length || !mod.kinds.every(k => KINDS.includes(k))) {
    problems.push(`extractors: ${rel} must export kinds, a non-empty list of ${joinList(KINDS, 'or')}`);
  }
  if (!Array.isArray(mod.extensions) || !mod.extensions.length || !mod.extensions.every(x => typeof x === 'string' && EXTENSION.test(x))) {
    problems.push(`extractors: ${rel} must export extensions, a list of lowercase file extensions each with its dot, such as .pdf`);
  }
  if (typeof mod.version !== 'string' || !mod.version.trim()) problems.push(`extractors: ${rel} must export version, a non-empty string`);
  return problems.length ? { problems } : { mod };
}
