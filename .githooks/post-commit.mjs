// Run by post-commit, and through it by post-checkout, post-merge and post-rewrite: makes .live's copy of tools/ as of
// the new HEAD with the builder the launchers use, under their lock. It waits past the 30 s after which a lock a killed
// launcher left is taken over, and a failure prints rather than keeping the old copy unseen.
import path from 'node:path';
import { liveTools, fail } from '../hooks/live.mjs';

try {
  liveTools(path.resolve(import.meta.dirname, '..'), { fix: 'run git hook run post-commit in the vault folder', refresh: true, wait: 35_000, fallback: false });
} catch (e) {
  fail('post-commit', e);
}
