#!/usr/bin/env node
// Mint (or list) portal invite templates — admin tool.
//
// An invite is an access-rights template: a reusable code that lets new agents
// self-register a persona, each stamped with the same capability profile.
//
// Invites are scoped (RFC-004): an invite must grant either access ROLES or a
// scoped GRANT (caps + where they apply). Blanket caps (every channel) are
// deprecated and refused unless --allow-blanket is passed.
//
// Usage (pick ONE grant form):
//   # access roles (preferred — live resolution, incl. mirrorRole):
//   node scripts/mint-invite.mjs --file invites.json --roles guest,reader
//
//   # inline scoped grant — explicit channels:
//   node scripts/mint-invite.mjs --file invites.json --guild <gid> \
//        --channels <cid>,<cid> --caps VIEW_CHANNEL,READ_HISTORY,SEND_MESSAGES
//
//   # inline scoped grant — mirror a Discord role's visibility (snapshot at enroll):
//   node scripts/mint-invite.mjs --file invites.json --guild <gid> --mirror-role <rid> --caps ...
//
//   # whole-guild/global (admin-ish; use sparingly):
//   node scripts/mint-invite.mjs --file invites.json --all --caps ...
//
//   # deprecated blanket caps (every channel) — must opt in:
//   node scripts/mint-invite.mjs --file invites.json --allow-blanket --caps ...
//
// Common: [--label x] [--subscriptions <cid>,<cid>] [--max-uses N]
//         [--expires-in-days N] [--code <explicit-code>]
//   node scripts/mint-invite.mjs --file invites.json --list
//
// The file is created if missing. Prints the new invite code to stdout.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const DEFAULT_CAPS = [
  'VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES', 'SEND_IN_THREADS',
  'ADD_REACTIONS', 'EDIT_OWN', 'DELETE_OWN',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

const file = arg('file', process.env.PORTAL_INVITES);
if (!file) {
  console.error('error: --file <path> (or PORTAL_INVITES) is required');
  process.exit(1);
}

const data = existsSync(file)
  ? JSON.parse(readFileSync(file, 'utf8'))
  : { invites: [] };
if (!Array.isArray(data.invites)) data.invites = [];

function describeGrant(inv) {
  if (inv.roles?.length) return `roles=${inv.roles.join(',')}`;
  if (inv.grant) {
    const s = inv.grant.scope;
    const scope = s.all ? 'all' : s.channels ? `channels[${s.channels.length}]` : s.mirrorRole ? `mirror:${s.mirrorRole}` : '?';
    return `grant{${scope}} caps=${(inv.grant.caps ?? []).join(',')}`;
  }
  if (inv.caps?.length) return `BLANKET(deprecated) caps=${inv.caps.join(',')}`;
  return 'deny';
}

if (flag('list')) {
  for (const inv of data.invites) {
    const cap = inv.maxUses !== undefined ? `${inv.uses ?? 0}/${inv.maxUses}` : `${inv.uses ?? 0}/∞`;
    const exp = inv.expiresAt ? `expires ${inv.expiresAt}` : 'no expiry';
    console.log(`${inv.code}  [${inv.label ?? '-'}]  uses ${cap}  ${exp}  ${describeGrant(inv)}`);
  }
  process.exit(0);
}

const code = arg('code') ?? `inv_${randomBytes(18).toString('base64url')}`;
if (data.invites.some((i) => i.code === code)) {
  console.error(`error: invite code already exists: ${code}`);
  process.exit(1);
}

const caps = (arg('caps') ?? DEFAULT_CAPS.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const subscriptions = (arg('subscriptions') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const maxUses = arg('max-uses') ? parseInt(arg('max-uses'), 10) : undefined;
const expiresInDays = arg('expires-in-days') ? parseInt(arg('expires-in-days'), 10) : undefined;
const expiresAt = expiresInDays
  ? new Date(Date.now() + expiresInDays * 86400_000).toISOString()
  : undefined;

const roles = (arg('roles') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const channels = (arg('channels') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const mirrorRole = arg('mirror-role');
const guildId = arg('guild');

// Resolve the grant form (RFC-004): roles | scoped grant | (opt-in) blanket.
let grantFields;
let summary;
if (roles.length) {
  grantFields = { roles };
  summary = `roles: ${roles.join(',')}`;
} else if (flag('all')) {
  grantFields = { grant: { caps, scope: { all: true } } };
  summary = `grant{all} caps: ${caps.join(',')}`;
} else if (channels.length || mirrorRole) {
  if (!guildId) {
    console.error('error: --guild <id> is required for --channels / --mirror-role scopes');
    process.exit(1);
  }
  const scope = mirrorRole ? { mirrorRole } : { channels };
  grantFields = { grant: { caps, scope }, guildId };
  summary = `grant{${mirrorRole ? `mirror:${mirrorRole}` : `channels[${channels.length}]`}} guild:${guildId} caps: ${caps.join(',')}`;
} else if (flag('allow-blanket')) {
  console.error('warning: minting a DEPRECATED blanket-caps invite (every channel). Prefer --roles or a scope.');
  grantFields = { caps };
  summary = `BLANKET caps: ${caps.join(',')}`;
} else {
  console.error('error: an invite must be scoped (RFC-004). Pass one of:');
  console.error('  --roles <name,...>            (preferred)');
  console.error('  --guild <id> --channels <id,...>   (or --mirror-role <id>)');
  console.error('  --all                         (whole guild / global)');
  console.error('  --allow-blanket               (deprecated: every channel)');
  process.exit(1);
}

const invite = {
  code,
  label: arg('label', 'invite'),
  ...grantFields,
  ...(subscriptions.length ? { subscriptions } : {}),
  ...(maxUses !== undefined ? { maxUses } : {}),
  uses: 0,
  ...(expiresAt ? { expiresAt } : {}),
};

data.invites.push(invite);
writeFileSync(file, JSON.stringify(data, null, 2) + '\n');

console.error(`minted invite "${invite.label}" → ${file}`);
console.error(`  ${summary}`);
if (maxUses !== undefined) console.error(`  maxUses: ${maxUses}`);
if (expiresAt) console.error(`  expiresAt: ${expiresAt}`);
console.log(code);
