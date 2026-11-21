import fs from 'node:fs';

// Stands in for the claude CLI in test/setup.test.mjs. FAKE_CLAUDE_STATE names a JSON file holding the version it reports,
// the installed plugins with their options, and the marketplaces; every call is appended to its calls list.
const file = process.env.FAKE_CLAUDE_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const stdin = args.includes('--values-stdin') ? fs.readFileSync(0, 'utf8') : '';
state.calls.push(stdin ? [...args, stdin.trim()] : args);
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const out = x => process.stdout.write(typeof x === 'string' ? `${x}\n` : `${JSON.stringify(x)}\n`);
const flag = name => args[args.indexOf(name) + 1];
const ID = 'obsidian-vault@obsidian-vault';

const [a, b] = args;
if (a === '--version') out(`${state.version} (Claude Code)`);
else if (a === 'plugin' && b === 'list') out(state.plugins.map(p => ({ id: p.id, enabled: p.enabled, scope: 'user' })));
else if (a === 'plugin' && b === 'install' && args.includes('--marketplace') === args[2].includes('@')) {
  process.stderr.write('Name the marketplace once: <plugin>@<marketplace>, or claude plugin install <plugin> --marketplace <source>\n');
  process.exitCode = 1;
} else if (a === 'plugin' && b === 'install') {
  const vault = flag('--config').replace(/^vault=/, '');
  state.plugins.push({ id: ID, enabled: true, inputs: { vault } });
  if (!state.marketplaces.includes('obsidian-vault')) state.marketplaces.push('obsidian-vault');
  out(`Installed ${ID}`);
} else if (a === 'plugin' && b === 'configure') {
  const p = state.plugins.find(x => x.id === args[2]);
  if (stdin) Object.assign(p.inputs, JSON.parse(stdin));
  else out({ pluginId: p.id, inputs: p.inputs });
} else if (a === 'plugin' && b === 'enable') state.plugins.find(x => x.id === args[2]).enabled = true;
else if (a === 'plugin' && b === 'marketplace' && args[2] === 'list') out(state.marketplaces.map(name => ({ name })));
else if (a === 'plugin' && (b === 'update' || b === 'marketplace')) out('ok');
else {
  process.stderr.write(`fake claude: no answer for ${args.join(' ')}\n`);
  process.exitCode = 1;
}
save();
