#!/usr/bin/env node
// Local end-to-end test of the RFC-005 admin panel against REAL Discord.
//
// Starts the real relay (one bot, against antra's test guild) with the admin
// HTTP API enabled, and serves the portal-admin SPA + proxies /admin/* to the
// API on a single localhost origin — so the Discord OAuth redirect lands back
// here and cookies stay same-origin.
//
// Prereqs (one-time):
//   1. In the Discord Developer Portal for THIS bot's application → OAuth2:
//        - copy the Client ID and a Client Secret
//        - add redirect:  http://localhost:8780/admin/callback
//   2. Build first:  npm run build   (this script runs from dist/)
//
// Run:
//   PORTAL_OAUTH_CLIENT_ID=...  PORTAL_OAUTH_CLIENT_SECRET=...  \
//   PORTAL_SUPERADMINS=<your-discord-user-id>  \
//   node scripts/admin-live.mjs
//
//   then open  http://localhost:8780  and "Login with Discord".
//
// Notes:
//   - You must be owner/ADMINISTRATOR/MANAGE_GUILD of the guild (or in
//     PORTAL_SUPERADMINS) for it to appear in the switcher.
//   - cookieSecure is OFF (plain http localhost). Never use these settings in prod.
import { readFileSync, statSync, createReadStream } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Relay } from '../dist/src/relay.js';

const GUILD = process.env.PORTAL_DEV_GUILD || '1289595876716707911'; // antra's server
const FRONT_PORT = parseInt(process.env.PORTAL_DEV_FRONT_PORT || '8780', 10);
const ADMIN_PORT = 8791;
const WS_PORT = 8790;

const need = (k) => {
  const v = process.env[k];
  if (!v) {
    console.error(`\nMissing ${k}. See the header of this script for setup.\n`);
    process.exit(1);
  }
  return v;
};

const discordToken = readFileSync(
  new URL('../../../chatperx/config/bots/strangesonnet45_discord_token', import.meta.url),
  'utf8',
).trim();

const config = {
  discordToken,
  wsPort: WS_PORT,
  avatarBaseUrl: '',
  guildIds: [GUILD],
  identityPath: new URL('../identity.test.json', import.meta.url).pathname,
  permissionsPath: new URL('../permissions.test.json', import.meta.url).pathname,
  rolePool: { size: 50, prefix: 'portal-' },
  webhookPoolSize: 1,
  heartbeatIntervalMs: 30000,
  guildMembersIntent: true,
  watchConfig: false,
  historyCacheTtlMs: 5000,
  maxInlineFileBytes: 8 * 1024 * 1024,
  allowPathFiles: false,
  replyLink: true,
  admin: {
    port: ADMIN_PORT,
    oauthClientId: need('PORTAL_OAUTH_CLIENT_ID'),
    oauthClientSecret: need('PORTAL_OAUTH_CLIENT_SECRET'),
    redirectUri: `http://localhost:${FRONT_PORT}/admin/callback`,
    postLoginUrl: '/',
    superadmins: (process.env.PORTAL_SUPERADMINS || '').split(',').map((s) => s.trim()).filter(Boolean),
    sessionTtlMs: 30 * 60 * 1000,
    auditPath: '/tmp/portal-admin-audit.jsonl',
    cookieSecure: false,
  },
};

// ── Front server: static SPA + reverse-proxy /admin/* → admin API ──

const SPA_DIR = fileURLToPath(new URL('../../portal-admin', import.meta.url));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function serveStatic(req, res) {
  let rel = normalize(decodeURIComponent(req.url.split('?')[0]));
  if (rel === '/' || rel === '') rel = '/index.html';
  const path = join(SPA_DIR, rel);
  if (!path.startsWith(SPA_DIR)) { res.writeHead(403).end('forbidden'); return; }
  try {
    if (statSync(path).isDirectory()) throw new Error('dir');
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    createReadStream(path).pipe(res);
  } catch {
    // SPA fallback.
    res.writeHead(200, { 'content-type': 'text/html' });
    createReadStream(join(SPA_DIR, 'index.html')).pipe(res);
  }
}

function proxyToAdmin(req, res) {
  const proxied = httpRequest(
    { host: '127.0.0.1', port: ADMIN_PORT, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode || 502, up.headers); // pass status + set-cookie + location through
      up.pipe(res);
    },
  );
  proxied.on('error', (e) => { res.writeHead(502).end(`admin api unreachable: ${e.message}`); });
  req.pipe(proxied);
}

const front = createServer((req, res) => {
  if (req.url.startsWith('/admin')) return proxyToAdmin(req, res);
  serveStatic(req, res);
});

// ── Boot ──

const relay = new Relay(config);
await relay.start();
await new Promise((r) => front.listen(FRONT_PORT, '127.0.0.1', r));

console.error('\n────────────────────────────────────────────────────────');
console.error(`  portal admin panel (LOCAL):  http://localhost:${FRONT_PORT}`);
console.error(`  relay WS gateway:            ws://127.0.0.1:${WS_PORT}`);
console.error(`  admin API (proxied):         http://127.0.0.1:${ADMIN_PORT}`);
console.error(`  guild under test:            ${GUILD}`);
console.error(`  super-admins:                ${config.admin.superadmins.join(', ') || '(none)'}`);
console.error(`  audit log:                   ${config.admin.auditPath}`);
console.error('────────────────────────────────────────────────────────\n');

const shutdown = () => {
  console.error('[admin-live] shutting down');
  front.close();
  relay.stop().finally(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
