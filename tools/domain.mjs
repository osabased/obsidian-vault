import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  config, vaultPath, statePath, withLock, writeText, appendLog, toPosix, inside, inVaultFolder, isMarkerName, isFileAt, markerDomains, mainCheckout,
  readJson, guarded, reloadConfig,
} from './lib/vault.mjs';
import { build } from './lib/build.mjs';
import { KEBAB, joinList } from './lib/rules.mjs';
import { inLatest } from './lib/quotes.mjs';
import { ownEntry, addReach } from './lib/sessions.mjs';
import { mainWorktree } from './lib/git.mjs';
import { namedIn } from './lib/neutral.mjs';
import { proposeNote, pickNote } from './lib/instructions.mjs';
import { valuesOf, addMember } from './lib/json.mjs';
import { agent, hasAgent, FIRST_AGENT, currentSession, shortName } from './lib/agents.mjs';
import { UsageError, readInput, refuse, failure, line } from './lib/input.mjs';

const RUN = 'usage: node tools/domain.mjs [session-id] < domain.json';
const USAGE = `${RUN}\n       node tools/domain.mjs --help lists the fields of domain.json`;

const help = () => [
  RUN,
  '',
  'domain.json is an object with these fields:',
  "  name         the domain's key, lowercase-kebab-case; not global, and not a domain the vault already has",
  '  title        a short phrase on one line',
  "  topics       the topics the domain's rules will have, a list of short strings",
  '  marker       a file name, with no folder in it, that every project of the kind has, such as its manifest.',
  "               This session's folder or a folder above it must hold it; the nearest that does is the project's root.",
  "  path         true, for a project no file marks: this session's project folder goes in vault.local.json, on this",
  '               machine only',
  '  vaultOnly    true, from a session in the vault folder, for a domain that holds pages only',
  '               Give one of marker, path and vaultOnly.',
  "  approved     the user's words agreeing to start this domain, as they typed them in their latest message",
  '',
  'Suggest the domain to the user in your reply and wait for their answer: an option they pick is your words, not theirs.',
].join('\n');

const FIELDS = new Set(['name', 'title', 'topics', 'marker', 'path', 'vaultOnly', 'approved']);
const REACH = ['marker', 'path', 'vaultOnly'];

const PASS = "Pass the session id from the taste vault's note at session start, or run this from the agent's own shell, which sets its session id.";

function sessionOf(sid) {
  if (!sid) refuse(`there's no session id to add a domain for. ${PASS}`);
  const { entry, notOwn } = ownEntry(sid);
  if (notOwn) refuse(notOwn);
  if (!entry) refuse(`the taste vault has no session ${sid}. ${PASS}`);
  const folder = entry.reach?.cwd ?? entry.cwd;
  if (!folder) refuse(`the taste vault has no folder for session ${sid}.`);
  return { entry, folder: toPosix(folder) };
}

// The nearest folder at or above the session's that holds the marker. Session start stops at the nearest folder holding
// any domain's marker, so a nearer one holding only another domain's would keep later sessions here out of this domain.
function markerRoot(folder, marker) {
  const others = markerDomains();
  for (let dir = folder; ; dir = path.dirname(dir)) {
    if (isFileAt(path.join(dir, marker))) return toPosix(mainCheckout(dir));
    const nearer = [...others].find(([m]) => isFileAt(path.join(dir, m)));
    if (nearer) {
      refuse(`${toPosix(dir)} holds ${nearer[0]}, which puts it in ${joinList(nearer[1], 'and')}, and a session takes the domains of the nearest folder holding a marker only. Give a file in ${toPosix(dir)} that marks this project's kind, or path: true.`);
    }
    if (path.dirname(dir) === dir) refuse(`no ${marker} in ${folder} or a folder above it. Give a file this project has that marks its kind, or path: true.`);
  }
}

function localDomains() {
  const file = vaultPath('vault.local.json');
  if (!fs.existsSync(file)) return {};
  let local;
  try { local = readJson(file); } catch { refuse("vault.local.json isn't valid JSON. /lint names the problem; it is the user's to fix."); }
  const mine = local?.domains ?? {};
  if (!local || typeof mine !== 'object' || Array.isArray(mine)) refuse('vault.local.json has no domains object. /lint names the problem; it is the user\'s to fix.');
  return mine;
}

function fields(p, { folder, vaultFolder }) {
  const unknown = Object.keys(p).find(k => !FIELDS.has(k));
  if (unknown) refuse(`${unknown} isn't a field domain.mjs takes. node tools/domain.mjs --help lists the fields.`);
  const name = line(p, 'name').normalize('NFC');
  if (!KEBAB.test(name)) refuse('name must be lowercase-kebab-case.');
  if (name === 'global') refuse('global is the domain every project is in, so it is never started. Pick another name.');
  if (Object.hasOwn(config().domains, name)) refuse(`vault.config.json already has a domain ${name}. Pick another name.`);
  if (Object.hasOwn(localDomains(), name)) refuse(`vault.local.json already has paths for ${name}, which are the user's to remove. Pick another name.`);
  const title = line(p, 'title');
  const topics = p.topics ?? [];
  if (!Array.isArray(topics) || topics.some(x => typeof x !== 'string' || !x.trim() || /[\r\n]/.test(x))) refuse('topics must be a list of short one-line strings.');
  const given = REACH.filter(k => p[k] !== undefined);
  if (given.length !== 1) {
    refuse("give one of marker, path and vaultOnly: marker for a file that marks the project's kind, path: true for this project's folder alone, or vaultOnly: true from the vault folder.");
  }
  const f = { name, title, topics: [...new Set(topics.map(x => x.trim()))] };
  if (p.vaultOnly !== undefined) {
    if (p.vaultOnly !== true) refuse('vaultOnly must be true.');
    if (!vaultFolder) refuse("vaultOnly is for a domain started from a session in the vault folder, where its pages are read. Give marker or path: true for this project.");
    f.vaultOnly = true;
  } else if (p.path !== undefined) {
    if (p.path !== true) refuse("path must be true: the folder added is this session's project folder.");
    if (vaultFolder) refuse("path adds this session's project folder, and the vault folder is in no project. Give marker or vaultOnly: true.");
    // A worktree, wherever it lives, checks out the same project as the main checkout.
    f.path = toPosix(mainWorktree(folder) ?? folder);
    // A path reaches every folder under it, so one holding the vault, the home folder or a drive takes in nearly every project.
    if (inside(f.path, vaultPath()) !== null || inside(f.path, os.homedir()) !== null || path.dirname(f.path) === f.path) {
      refuse(`${f.path} holds the taste vault, the home folder or a whole drive, so a domain by this path would reach nearly every project. Start the session in the project's own folder, or give marker.`);
    }
    f.root = f.path;
  } else {
    f.marker = line(p, 'marker');
    if (!isMarkerName(f.marker)) refuse("marker must be a file name with no folder in it, such as a manifest every project of the kind has.");
    if (!vaultFolder) f.root = markerRoot(folder, f.marker);
  }
  return f;
}

function clashes(f) {
  const hits = namedIn(vaultPath(), { [f.name]: { title: f.title } });
  if (!hits.length) return;
  const more = hits.length > 3 ? `, and ${hits.length - 3} more` : '';
  refuse(`the vault's tools, skills, tests or AGENTS.md name no domain, and they already use this name or title: ${hits.slice(0, 3).join('; ')}${more}. Pick another.`);
}

function approval(entry, p) {
  const approved = line(p, 'approved', false);
  if (!approved) refuse("approved is missing: give the user's words agreeing to start this domain, from their latest message.");
  const agreed = inLatest(entry, approved);
  if (agreed === null) refuse("the taste vault has no transcript for this session, so it can't check approved is the user's words. Ask the user to add the domain to vault.config.json.");
  if (!agreed) {
    refuse("approved isn't in the user's latest message. Suggest the domain in your reply, and once the user agrees, pass their words as approved.");
  }
}

function withDomain(text, name, entry) {
  const top = text.indexOf('{');
  if (top < 0) throw new Error('the file holds no JSON object');
  const domains = valuesOf(text, top).get('domains');
  if (domains === undefined) return addMember(text, top, 1, 'domains', { [name]: entry });
  if (text[domains] !== '{') refuse("the file's domains isn't an object. /lint names the problem; it is the user's to fix.");
  return addMember(text, domains, 2, name, entry);
}

function write(f) {
  const configFile = vaultPath('vault.config.json');
  const raw = fs.readFileSync(configFile, 'utf8');
  // Another run may have added the key since the checks.
  if (Object.hasOwn(JSON.parse(raw.replace(/^\uFEFF/, '')).domains ?? {}, f.name)) refuse(`vault.config.json already has a domain ${f.name}. Pick another name.`);
  const entry = { title: f.title, topics: f.topics, ...(f.marker ? { markers: [f.marker] } : {}), ...(f.vaultOnly ? { vaultOnly: true } : {}) };
  const local = vaultPath('vault.local.json');
  let localText;
  if (f.path) {
    if (Object.hasOwn(localDomains(), f.name)) refuse(`vault.local.json already has paths for ${f.name}, which are the user's to remove. Pick another name.`);
    localText = fs.existsSync(local) ? withDomain(fs.readFileSync(local, 'utf8'), f.name, { paths: [f.path] }) : `${JSON.stringify({ domains: { [f.name]: { paths: [f.path] } } }, null, 2)}\n`;
  }
  writeText(configFile, withDomain(raw, f.name, entry));
  if (localText) writeText(local, localText);
  return entry;
}

function reply(f, entry, { sid, vaultFolder, agentOf }) {
  const configFile = toPosix(vaultPath('vault.config.json'));
  const local = toPosix(vaultPath('vault.local.json'));
  const head = `**New domain** ${f.name}, "${f.title}": `;
  const reach = f.vaultOnly ? 'it holds pages only, which sessions in the vault folder read.'
    : f.path ? `${f.path} is in it, on this machine only.`
    : vaultFolder ? `a project holding ${f.marker} is in it. The vault folder is in no project, so domain.mjs didn't look for ${f.marker}.`
    : `a project holding ${f.marker} is in it, such as ${f.root}.`;
  const sharing = f.marker ? Object.entries(config().domains).filter(([d, c]) => d !== f.name && Array.isArray(c?.markers) && c.markers.includes(f.marker)).map(([d]) => d) : [];
  const shared = sharing.length ? ` ${joinList(sharing, 'and')} also ${sharing.length === 1 ? 'has' : 'have'} ${f.marker} as a marker, so a project holding it is in both.` : '';
  const files = f.path ? `its entries in ${configFile} and ${local}; both files are yours` : `its entry in ${configFile}, which is yours`;
  const where = f.marker ? ' Other machines get it once the vault is committed and pulled there.' : '';
  const lines = [
    `${head}${reach}${shared}`,
    `\`"${f.name}": ${JSON.stringify(entry)}\`. To change or remove it, edit or delete ${files}.${where}`,
  ];
  // A vault-folder session proposes for every domain already, and /ingest tells it how.
  const notes = vaultFolder ? [] : [proposeNote(sid, agentOf, [f.name]), pickNote(sid)];
  return [
    `Added ${f.name} to vault.config.json${f.path ? ', and its folder to vault.local.json' : ''}. It reaches the rest of this session.`,
    ...notes,
    'End your reply with these two lines as they are:',
    '',
    ...lines,
  ].join('\n');
}

// The input is read after the session is checked, so a script run from the wrong place says that first.
function addDomain(sid, input) {
  const { entry: session, folder } = sessionOf(sid);
  const vaultFolder = inVaultFolder(folder);
  const p = input();
  const f = fields(p, { folder, vaultFolder });
  clashes(f);
  approval(session, p);
  const entry = withLock(statePath('config.lock'), () => {
    const written = write(f);
    if (f.root) addReach(sid, { domain: f.name, root: f.root });
    appendLog([`added domain ${f.name} · session ${shortName(sid, session.agent)}`]);
    return written;
  });
  // index.md lists the domains, so it is rebuilt; the config is written by now, so a failed build costs only the generated files.
  reloadConfig();
  guarded('build', build);
  return reply(f, entry, { sid, vaultFolder, agentOf: agent(hasAgent(session.agent) ? session.agent : FIRST_AGENT) });
}

const args = process.argv.slice(2);
try {
  if (args[0] === '--help' && args.length === 1) console.log(help());
  else if (args.length > 1) throw new UsageError();
  else console.log(addDomain(args[0] ?? currentSession()?.id, readInput));
} catch (e) {
  const f = failure(e, 'domain', USAGE, 'Not added');
  console.error(f.message);
  process.exitCode = f.code;
}
