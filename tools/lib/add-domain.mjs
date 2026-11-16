import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  config, vaultPath, statePath, withLock, writeText, appendLog, toPosix, inside, inVaultFolder, isMarkerName, isFileAt, markerDomains, mainCheckout,
  readJson, guarded, reloadConfig, newId, today,
} from './vault.mjs';
import { build } from './build.mjs';
import { KEBAB, joinList } from './rules.mjs';
import { callerEntry, addReach, PASS } from './sessions.mjs';
import { namedIn } from './neutral.mjs';
import { proposeNote, pickNote } from './instructions.mjs';
import { valuesOf, addMember } from './json.mjs';
import { typedFor, shortName } from './agents.mjs';
import { refuse, line, lines } from './input.mjs';
import { makeOffer, offerText, consentOf, declined } from './offers.mjs';
import { entryOf, closeEntry, queueLocked, queueEntry, appendEntry } from './queue.mjs';

function openEntry(id) {
  const { entry, decided } = entryOf(id);
  if (!entry) refuse(`there's no entry \`${id}\` in raw/queue/.`);
  if (decided) refuse(`\`${id}\` was already ${decided}.`);
  return entry;
}

const FIELD_NAMES = new Set(['name', 'title', 'topics', 'marker', 'path', 'vaultOnly']);

const REACH = ['marker', 'path', 'vaultOnly'];

function sessionOf(sid) {
  const entry = callerEntry(sid, { noId: `there's no session id to add a domain for. ${PASS}` });
  const folder = entry.reach?.cwd ?? entry.cwd;
  if (!folder) refuse(`the vault has no folder for session ${sid}.`);
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

function fields(p, { folder, vaultFolder, mainWorktree }) {
  const unknown = Object.keys(p).find(k => !FIELD_NAMES.has(k));
  if (unknown) refuse(`${unknown} isn't a field domain.mjs takes. The \`domain\` tool's schema lists the fields.`);
  const name = line(p, 'name').normalize('NFC');
  if (!KEBAB.test(name)) refuse('name must be lowercase-kebab-case.');
  if (name === 'global') refuse('global is the domain every project is in, so it is never started. Pick another name.');
  if (Object.hasOwn(config().domains, name)) refuse(`vault.config.json already has a domain ${name}. Pick another name.`);
  if (Object.hasOwn(localDomains(), name)) refuse(`vault.local.json already has paths for ${name}, which are the user's to remove. Pick another name.`);
  const title = line(p, 'title');
  const topics = lines(p, 'topics');
  const given = REACH.filter(k => p[k] !== undefined);
  if (given.length !== 1) {
    refuse("give one of marker, path and vaultOnly: marker for a file that marks the project's kind, path: true for this project's folder alone, or vaultOnly: true from the vault folder.");
  }
  const f = { name, title, topics: [...new Set(topics)] };
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
      refuse(`${f.path} holds the vault, the home folder or a whole drive, so a domain by this path would reach nearly every project. Start the session in the project's own folder, or give marker.`);
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
  refuse(`the vault's tools, skills, tests, AGENTS.md and reference files name no domain, and they already use this name or title: ${hits.slice(0, 3).join('; ')}${more}. Pick another.`);
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

function reply(f, entry, vaultFolder) {
  const configFile = toPosix(vaultPath('vault.config.json'));
  const local = toPosix(vaultPath('vault.local.json'));
  const head = `**New domain** ${f.name}, "${f.title}": `;
  const reach = f.vaultOnly ? 'it holds pages only, which sessions in the vault folder read.'
    : f.path ? `${f.path} is in it, on this machine only.`
    : vaultFolder ? `a project holding ${f.marker} is in it. The vault folder is in no project, so the vault didn't look for ${f.marker}.`
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
  const notes = vaultFolder ? [] : [proposeNote([f.name]), pickNote()];
  return [
    `Added ${f.name} to vault.config.json${f.path ? ', and its folder to vault.local.json' : ''}. It reaches the rest of this session.`,
    ...notes,
    'End your reply with these two lines as they are:',
    '',
    ...lines,
  ].join('\n');
}

// What the user agrees to: the domain's reach, worded as the reply on keep words it, and its topics.
function offerLines(f, vaultFolder) {
  const reach = f.vaultOnly ? 'it holds pages only'
    : f.path ? `${f.path} is in it, on this machine only`
    : vaultFolder ? `a project holding ${f.marker} is in it`
    : `a project holding ${f.marker} is in it, such as ${f.root}`;
  return [`**Start this domain?** ${f.name}, "${f.title}": ${reach}. Topics: ${f.topics.length ? f.topics.join(', ') : 'none'}.`];
}

// Every new domain is offered first, in every mode and from the vault folder too, since it changes what every later
// session in such a project loads. The input is read after the session is checked, so a script run from the wrong place
// says that first: p is the input, or a function that reads it. kept is the consent keep found, with the offer's text and
// code, which the fields must still give. mainWorktree is lib/git.mjs's, passed in by the script, since hooks load lib/
// and may take only changedFiles from lib/git.mjs. queued is the review queue entry propose offers the domain again from;
// the offer names it in its fields, so keep closes it once the domain is written. queueAs drafts the domain into the
// review queue, as /lint does for a kind of project its rules keep matching, instead of offering it.
export function addDomain(sid, p, { kept = null, mainWorktree, queued = null, queueAs = null }) {
  const { entry: session, folder } = sessionOf(sid);
  const vaultFolder = inVaultFolder(folder);
  if (typeof p === 'function') p = p();
  if (kept && p && Object.hasOwn(p, 'queued')) {
    queued = openEntry(p.queued);
    p = queued.fields;
  }
  const f = fields(p, { folder, vaultFolder, mainWorktree });
  clashes(f);
  const offer = offerLines(f, vaultFolder);
  if (queueAs) {
    const id = newId('u');
    appendEntry(queueEntry({
      id, kind: 'domain', why: queueAs.why, unattended: queueAs.unattended, from: null, session: sid, entry: session,
      domain: f.name, key: f.name, fields: p, text: offerText(offer, null), quote: null, checked: today(),
    }), shortName(sid, session.agent));
    return queueAs.reply(id);
  }
  if (!kept) {
    if (consentOf(session) === 'code' && !typedFor(session)) refuse("the vault has no transcript for this session, so it can't check the user agreed. Ask the user to add the domain to vault.config.json.");
    if (consentOf(session) === 'prompt' && declined(sid, offerText(offer, null))) refuse("the user denied starting this domain at the prompt in this session. Don't offer it again unless they ask.");
    return makeOffer({ kind: 'domain', sid, entry: session, key: f.name, fields: queued ? { queued: queued.id } : p, lines: offer }).reply;
  }
  if (offerText(offer, kept.code) !== kept.text) refuse("the vault changed since the offer, so it isn't what the user agreed to. Propose it again.");
  // Under queue.lock too for a queued entry, so a drop can't land between the check and the kept row.
  const entry = withLock(statePath('config.lock'), () => (queued ? queueLocked : g => g())(() => {
    if (queued) openEntry(queued.id);
    const written = write(f);
    if (f.root) addReach(sid, { domain: f.name, root: f.root });
    appendLog([`added domain ${f.name} · session ${shortName(sid, session.agent)}`]);
    if (queued) closeEntry({ id: queued.id, decision: 'kept', offer: kept.offer ?? null, sid, agentName: session.agent });
    return written;
  }));
  // index.md lists the domains, so it is rebuilt; the config is written by now, so a failed build costs only the generated files.
  reloadConfig();
  guarded('build', build);
  return reply(f, entry, vaultFolder);
}
