// The vault's tools, each a script in tools/ that takes its JSON on stdin and the session the call record bound as an
// argument. A marked tool is one the user allows at the client's prompt, which is their consent; keep and proposals
// count on it.
export const TOOLS = [
  { name: 'propose', script: 'propose.mjs', argv: (sid, call) => [sid, call] },
  { name: 'keep', script: 'keep.mjs', argv: (sid, call) => [sid, call], marked: true },
  { name: 'proposals', script: 'proposals.mjs', argv: (sid, call) => [sid, call], marked: true },
  { name: 'domain', script: 'domain.mjs', argv: sid => [sid] },
  { name: 'pick', script: 'pick.mjs', argv: sid => [sid] },
  { name: 'log', script: 'log.mjs', argv: sid => ['--json', sid] },
  { name: 'search', script: 'search.mjs', argv: () => ['--json'], readOnly: true },
  { name: 'status', script: 'status.mjs', argv: sid => [sid], readOnly: true },
];

export const toolNamed = name => TOOLS.find(t => t.name === name) ?? null;

const isObject = x => typeof x === 'object' && x !== null && !Array.isArray(x);

// What a script's --schema printed, held to the shape a client needs, so one broken script can't hand a client a tool it
// would reject the whole list over.
export function parseSchema(text) {
  let s;
  try { s = JSON.parse(text); } catch (e) { throw new Error(`its output isn't JSON: ${e.message}`); }
  if (!isObject(s) || typeof s.description !== 'string' || !isObject(s.inputSchema) || s.inputSchema.type !== 'object') {
    throw new Error('its output has no description and object inputSchema');
  }
  return { description: s.description, inputSchema: s.inputSchema };
}

export const listing = (row, schema, marker) => ({
  name: row.name,
  ...schema,
  ...(row.marked && marker ? { _meta: marker } : {}),
  ...(row.readOnly ? { annotations: { readOnlyHint: true } } : {}),
});
