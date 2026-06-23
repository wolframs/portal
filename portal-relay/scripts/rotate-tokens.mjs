#!/usr/bin/env node
// Forced token rotation → hashed-at-rest (RFC-005 §5.9, migration mechanics).
//
// Tokens are stored HASHED in identity.json (sha256:...). This is the migration
// tool: it mints a FRESH token for each persona, writes only the hash, and prints
// the new plaintext tokens ONCE so you can redeliver them out-of-band. There is
// no lazy/legacy path — after this runs, the old plaintext tokens are dead and
// identity.json contains no replayable secret.
//
// Usage:
//   # rotate every persona (the cutover migration):
//   node scripts/rotate-tokens.mjs --file identity.json
//
//   # rotate a single persona (e.g. lost-token recovery):
//   node scripts/rotate-tokens.mjs --file identity.json --persona lena
//
//   # just hash a known plaintext (e.g. to set a specific token by hand):
//   node scripts/rotate-tokens.mjs --hash 'my-plaintext-token'
//
// Prints the new token(s) to STDOUT; status to STDERR. A backup of the prior
// file is written alongside as <file>.bak before any change.
import { readFileSync, writeFileSync, existsSync, copyFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function flag(name) {
  return process.argv.includes(`--${name}`);
}

// Must match IdentityStore.hashToken / generateToken in src/identity.ts.
const hashToken = (plain) => 'sha256:' + createHash('sha256').update(plain).digest('hex');
const generateToken = () => `pt_${randomBytes(24).toString('base64url')}`;

const hashOnly = arg('hash');
if (hashOnly) {
  console.log(hashToken(hashOnly));
  process.exit(0);
}

const file = arg('file', process.env.PORTAL_IDENTITY);
if (!file) {
  console.error('error: --file <path> (or PORTAL_IDENTITY) is required');
  process.exit(1);
}
if (!existsSync(file)) {
  console.error(`error: identity file not found: ${file}`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(file, 'utf8'));
if (!Array.isArray(data.personas)) {
  console.error('error: identity file has no personas array');
  process.exit(1);
}

const inPlace = flag('in-place');
const only = arg('persona');
const targets = only ? data.personas.filter((p) => p.id === only) : data.personas;
if (only && targets.length === 0) {
  console.error(`error: no persona with id ${only}`);
  process.exit(1);
}

copyFileSync(file, `${file}.bak`);
console.error(`[rotate-tokens] backup written: ${file}.bak`);

if (inPlace) {
  // Migrate without changing the secret: hash each EXISTING plaintext token so the
  // file holds only hashes, while the agents keep the tokens they already have
  // (zero redelivery). For promoting a live deployment to hashed-at-rest. Already
  // hashed tokens are left untouched (idempotent).
  let migrated = 0;
  let already = 0;
  for (const p of targets) {
    if (typeof p.token !== 'string' || !p.token) continue;
    if (p.token.startsWith('sha256:')) { already++; continue; }
    p.token = hashToken(p.token);
    migrated++;
  }
  writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  console.error(`[rotate-tokens] in-place: hashed ${migrated} token(s), ${already} already hashed, in ${file}`);
  console.error('[rotate-tokens] agents keep their current tokens — no redelivery needed.');
  process.exit(0);
}

const issued = [];
for (const p of targets) {
  const plain = generateToken();
  p.token = hashToken(plain);
  issued.push({ id: p.id, token: plain });
}

writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
console.error(`[rotate-tokens] rotated ${issued.length} token(s) in ${file} (hashed at rest)`);
console.error('[rotate-tokens] deliver these NEW tokens out-of-band — they are shown only once:');
for (const { id, token } of issued) console.log(`${id}\t${token}`);
