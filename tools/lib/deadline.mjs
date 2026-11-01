import path from 'node:path';

// Claude Code kills a hook at its timeout without a word, and hook input doesn't carry the timeout, so the hook command
// passes it as VAULT_HOOK_TIMEOUT. The hook stops a margin before it, while it still has time to say why. A JS timer
// can't fire inside a synchronous loop, so the loops that walk the notes call checkDeadline. Scripts and lint have no
// timeout, so only a process started from a file in hooks/ keeps one.
const DEFAULT_SECONDS = 10;
const inHook = path.basename(path.dirname(process.argv[1] ?? '')) === 'hooks';

let limit;
function deadline() {
  if (!limit) {
    const given = Number(process.env.VAULT_HOOK_TIMEOUT);
    const timeout = Number.isFinite(given) && given > 0 ? given : DEFAULT_SECONDS;
    const margin = Math.min(1, timeout / 5);
    limit = { timeout, margin, ms: (timeout - margin) * 1000 };
  }
  return limit;
}

// performance.now() counts from the process's start, which the timeout counts from too.
export function checkDeadline() {
  if (!inHook) return;
  const { timeout, margin, ms } = deadline();
  if (performance.now() > ms) throw new Error(`stopped at its deadline, ${margin} s before the ${timeout} s hook timeout`);
}
