import { readJsonSafe, safeId } from '../vault.mjs';
import { registry } from '../sessions.mjs';
import { recordCall, keepCallFor } from '../calls.mjs';
import { consentOf } from '../offers.mjs';

// Runs before the call, and before the user's prompt for a tool that needs one, so the record exists whether the user
// allows or denies. Only keep carries an offer, and where the user agrees at the prompt its first call for an offer is
// the only one they are asked about. Where they agree by a code, a keep refused for its lines leaves the offer pending,
// so a retry with the right lines goes through.
export function vaultCall(event) {
  if (!event.call) throw new Error(`the ${event.tool} call came with no call id, so the vault can't tell which session made it`);
  const prompted = consentOf(readJsonSafe(registry(safeId(event.session)))) === 'prompt';
  const offer = prompted && event.tool === 'keep' && typeof event.args?.id === 'string' ? event.args.id : null;
  const { seen } = recordCall({ call: event.call, session: event.session, subagent: event.subagent, tool: event.tool, offer, input: event.args });
  if (!seen) return null;
  if (!keepCallFor(offer)?.allowed) {
    return { deny: `The user was already asked to keep offer \`${offer}\` and denied it, or hasn't answered yet. A Deny ends a proposal: don't offer it again unless the user asks.` };
  }
  return { deny: `Offer \`${offer}\` already had its one keep call, which the user allowed. If that call didn't write, propose it again for a new offer.` };
}
