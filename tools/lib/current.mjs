import fs from 'node:fs';
import path from 'node:path';

// The copy of tools/ in <root>/.live/ that .live/current names, or null when there is none whole. Imported by the
// plugin's launchers from their own tools/ and by the server from its .live copy, so it uses nothing but node.
export const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export function currentCopy(root) {
  const live = path.join(root, '.live');
  try {
    const tree = fs.readFileSync(path.join(live, 'current'), 'utf8').trim();
    if (TREE.test(tree) && fs.existsSync(path.join(live, tree, '.tree'))) return path.join(live, tree);
  } catch {}
  return null;
}
