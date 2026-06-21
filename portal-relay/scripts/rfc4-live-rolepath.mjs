// Live RFC-004 — the role/overwrite-EDIT invalidation path, which needs a bot
// with Manage Roles (admin). Complements rfc4-live.mjs (which uses @everyone +
// channelCreate). Here we exercise:
//   - mirrorRole pointing at a REAL (non-@everyone) Discord role;
//   - a live overwrite EDIT (channelUpdate) removing the role's view → cache
//     busts by guild → capabilities_update re-pushed with empty caps;
//   - a live roleDelete → invalidation.
//
// MUTATES the guild: creates 1 role + 1 private channel; deletes both in finally.
// Token via RFC4_TOKEN/DISCORD_TOKEN env. Run on an admin bot.
//   set -a; . relay.env; set +a; RFC4_WS_PORT=8799 node scripts/rfc4-live-rolepath.mjs
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { Relay } from '../dist/src/relay.js';
import { PortalClient } from '../../portal-client/dist/src/index.js';
import { enroll } from '../../portal-client/dist/src/enroll.js';

const GUILD = process.env.RFC4_GUILD ?? '1289595876716707911';
const PORT = parseInt(process.env.RFC4_WS_PORT ?? '8799', 10);
const VIEW_CHANNEL = '1024';
const token = (process.env.RFC4_TOKEN ?? process.env.DISCORD_TOKEN ?? '').trim();
if (!token) { console.error('need RFC4_TOKEN or DISCORD_TOKEN'); process.exit(1); }
const API = 'https://discord.com/api/v10';
const auth = { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' };
const URL_WS = `ws://127.0.0.1:${PORT}`;
const log = (...a) => console.log('[rfc4-rp]', ...a);
const ts = String(process.hrtime.bigint()).slice(-6);
const IDENT = '/tmp/rfc4rp-identity.json', PERMS = '/tmp/rfc4rp-permissions.json', INV = '/tmp/rfc4rp-invites.json';

let pass = 0, fail = 0;
const check = (n, ok, d = '') => { ok ? (pass++, log(`✅ ${n}`, d)) : (fail++, log(`❌ ${n}`, d)); };
async function api(m, p, b) {
  const r = await fetch(`${API}${p}`, { method: m, headers: auth, body: b ? JSON.stringify(b) : undefined });
  if (!r.ok) throw new Error(`${m} ${p} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const capsOf = (chs, id) => chs.find((c) => c.id === id)?.capabilities ?? null;

async function main() {
  const me = await api('GET', '/users/@me');
  // Hoisted so finally cleans up even if setup throws.
  let relay = null, role = null, ch = null, cli;
  try {
    role = await api('POST', `/guilds/${GUILD}/roles`, { name: `rfc4-real-${ts}`, mentionable: false });
    // Private channel: hidden from @everyone, visible to the bot AND to our role.
    ch = await api('POST', `/guilds/${GUILD}/channels`, {
      name: `rfc4-rolep-${ts}`, type: 0,
      permission_overwrites: [
        { id: GUILD, type: 0, deny: VIEW_CHANNEL },
        { id: me.id, type: 1, allow: '68608' },
        { id: role.id, type: 0, allow: VIEW_CHANNEL },
      ],
    });
    log(`setup: role=${role.id} ch=${ch.id}`);

    writeFileSync(IDENT, JSON.stringify({ personas: [] }));
    writeFileSync(PERMS, JSON.stringify({
      roles: { rfc4real: { caps: ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'], scope: { mirrorRole: role.id }, guildId: GUILD } },
      personas: {},
    }));
    writeFileSync(INV, JSON.stringify({ invites: [{ code: `rolep-${ts}`, label: 'rolep', roles: ['rfc4real'], maxUses: 9 }] }));

    relay = new Relay({
      discordToken: token, wsPort: PORT, avatarBaseUrl: '', guildIds: [GUILD],
      identityPath: IDENT, permissionsPath: PERMS, invitesPath: INV, attributionPath: '/tmp/rfc4rp-attr.json',
      rolePool: { size: 50, prefix: 'portal-' }, webhookPoolSize: 1,
      heartbeatIntervalMs: 30000, guildMembersIntent: process.env.RFC4_MEMBERS_INTENT === 'true', watchConfig: false,
      historyCacheTtlMs: 0, maxInlineFileBytes: 8 * 1024 * 1024, allowPathFiles: false, replyLink: true,
    });
    await relay.start();
    await sleep(4000);
    const cr = await enroll({ url: URL_WS, invite: `rolep-${ts}`, desiredName: 'rfc4-rolep' });
    cli = new PortalClient({ url: URL_WS, token: cr.token, personaId: cr.personaId });
    await cli.connect();

    // Baseline: mirrorRole of a REAL role → persona sees the channel that role can view.
    const a = await cli.call('list_channels', { guildId: GUILD });
    check('mirror(real role) SEES the role-visible private channel', (capsOf(a.channels, ch.id) ?? []).includes('READ_HISTORY'),
      `caps=[${capsOf(a.channels, ch.id)}]`);

    // Live overwrite EDIT (channelUpdate): remove the role's view → invalidation.
    const seen = [];
    const off = cli.on('event', (e) => { if (e.type === 'capabilities_update' && e.channelId === ch.id) seen.push(e); });
    await api('DELETE', `/channels/${ch.id}/permissions/${role.id}`); // role can no longer view ch
    await sleep(2500);
    off();
    check('overwrite-edit → capabilities_update pushed (channelUpdate path)', seen.length > 0,
      seen.length ? `caps=[${seen[seen.length - 1].capabilities}]` : 'no event');
    const b = await cli.call('list_channels', { guildId: GUILD });
    check('caps now EMPTY after role lost channel view', (capsOf(b.channels, ch.id) ?? ['x']).length === 0,
      `caps=[${capsOf(b.channels, ch.id)}]`);

    // Re-grant, confirm it comes back (proves recompute, not just one-way drop).
    await api('PUT', `/channels/${ch.id}/permissions/${role.id}`, { type: 0, allow: VIEW_CHANNEL });
    await sleep(2000);
    const c = await cli.call('list_channels', { guildId: GUILD });
    check('caps RESTORED after role regains channel view', (capsOf(c.channels, ch.id) ?? []).includes('READ_HISTORY'),
      `caps=[${capsOf(c.channels, ch.id)}]`);

    // Live roleDelete: deleting the mirrored role → scope empties (fail-closed).
    await api('DELETE', `/guilds/${GUILD}/roles/${role.id}`);
    await sleep(2500);
    const d = await cli.call('list_channels', { guildId: GUILD });
    check('caps EMPTY after mirrored role deleted (roleDelete path)', (capsOf(d.channels, ch.id) ?? ['x']).length === 0,
      `caps=[${capsOf(d.channels, ch.id)}]`);
  } finally {
    cli?.close();
    await relay?.stop().catch(() => {});
    if (ch) await api('DELETE', `/channels/${ch.id}`).catch(() => {});
    if (role) await api('DELETE', `/guilds/${GUILD}/roles/${role.id}`).catch(() => {}); // no-op if already deleted
    for (const f of [IDENT, PERMS, INV, '/tmp/rfc4rp-attr.json']) rmSync(f, { force: true });
  }
  log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error('[rfc4-rp] FAILED:', e); process.exit(1); });
