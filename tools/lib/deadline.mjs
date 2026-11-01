// Claude Code kills a hook at its timeout without a word, and hook input doesn't carry the timeout, so the hook command
// passes it as VAULT_HOOK_TIMEOUT. The hook stops a margin before it, while it still has time to say why. A JS timer
// can't fire inside a synchronous loop, so the loops that walk the notes call checkDeadline. Scripts and lint have no
// timeout, so only runHook arms it.
const DEFAULT_SECONDS = 10;
let limit;
let armed = false;

export const armDeadline = () => { armed = true; };

function deadline() {
  if (!limit) {
    const given = Number(process.env.VAULT_HOOK_TIMEOUT);
    const timeout = Number.isFinite(given) && given > 0 ? given : DEFAULT_SECONDS;
    const margin = Math.min(1, timeout / 5);
    limit = { timeout, margin, ms: (timeout - margin) * 1000 };
  }
  return limit;
}

// performance.now() counts from the process's start, which the timeout counts from too. The code lets guarded tell this
// error from a section's own failure, since a hook past its deadline has to fail, not carry on with what is left.
export function checkDeadline() {
  if (!armed) return;
  const { timeout, margin, ms } = deadline();
  if (performance.now() > ms) throw Object.assign(new Error(`stopped at its deadline, ${margin} s before the ${timeout} s hook timeout`), { code: 'EDEADLINE' });
}

// Milliseconds left before the deadline, for work that can't call checkDeadline, such as another program. Infinity when
// the process has no deadline.
export const remaining = () => (armed ? deadline().ms - performance.now() : Infinity);
