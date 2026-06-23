# PORTAL RFC-005 — Admin panel, Discord-OAuth delegation & self-service rights

- **Status:** Implemented (P1–P4) — relay admin API in `portal-relay/src/admin/`,
  protocol ops `claim_invite`/`rotate_token` (proto v2), hashed-at-rest tokens
  (`scripts/rotate-tokens.mjs`), SPA in `portal-admin/`.
- **Author:** Antra (drafted with Claude Code)
- **Date:** 2026-06-22
- **Affects:** `portal-relay` (new `admin/` module: HTTP API, Discord OAuth, sessions,
  authz, audit — reusing `IdentityStore` / `PermissionsStore` / `InviteStore` mutators),
  `portal-protocol` (new `claim_invite` op; `InviteTemplate.mode`), new
  `portal-admin` frontend (static SPA), deployment (Caddy vhost + OAuth app creds).
- **Protocol version:** minor bump (additive `claim_invite` client op; `mode` is
  additive config).
- **Depends on:** RFC-002 (`list_roles` — the role/channel catalogs the panel
  surfaces), RFC-004 (scoped invites & access roles — the objects it manages).
  **Blocks:** multi-tenant, self-service operation by non-root server admins.

---

## 1. Summary

Give portal a **web admin panel** and the **delegated, audited management** it
needs to be multi-tenant:

1. **Relay-embedded admin API** — an authenticated HTTP API on the relay,
   reusing the stores' existing mutators (single writer, no file-race), fronted
   by Caddy with TLS. A static SPA is the panel.
2. **Discord-OAuth delegation** — admins log in with Discord; portal derives
   *which guilds they may administer* from their **live Discord permissions**
   (`ADMINISTRATOR` / `MANAGE_GUILD` / owner), plus a small operator super-admin
   list. Consistent with `mirrorRole`: portal keeps deferring to Discord as the
   source of truth on "who's an admin here."
3. **Scoped CRUD + audit** — a guild-admin may mint/revoke invites, define access
   roles, and assign/revoke persona rights — but only within guilds they admin.
   Every mutation is recorded in an append-only audit log.
4. **Self-service rights** — invites become *rights grants*, not just a persona
   factory: an existing persona can **claim** an invite to *expand* its rights
   (`claim_invite`), gated by an invite `mode`.

## 2. Motivation

Today **all** management is hand-editing three JSON files on the server (or
`mint-invite.mjs`). That means:

- **No delegation.** Only someone with shell + `sudo` on the relay host can
  change anything. Server admins can't manage their own guild's access.
- **No identity or audit.** This RFC's own development surfaced the failure mode
  live: prod config (`anima-agent` gaining `MANAGE_MESSAGES`) was edited
  out-of-band by an actor nobody could name, with no record of who/when/why. At
  one tenant that's a nuisance; at several it's untenable.
- **No self-service growth.** Invites only *mint new* personas. Extending an
  existing persona's rights means a human editing `permissions.json`.

To run portal for multiple guilds and multiple server-admins, management has to
become **self-service, scoped, and audited**.

## 3. Background — current management surface

- **Three stores**, each a `WatchedFile`-backed JSON store with in-process
  mutators that persist + `emit` change events the relay turns into wire pushes:
  - `IdentityStore` (`identity.json`) — who: personas + tokens.
  - `PermissionsStore` (`permissions.json`) — what: `roles` catalog +
    per-persona `{ roles, policy }`; mutators `setPersonaRoles` /
    `setPersonaPolicy` / `setChannel` / `removePersona`; `couldAccessGuild`.
  - `InviteStore` (`invites.json`) — invite templates; `check` / `consume`.
- **The relay is the single in-process writer** (it persists on `enroll` /
  `consume`). External edits are picked up by hot-reload, but concurrent
  relay-write + external-write can clobber — a pre-existing race.
- **The gateway** (`gateway.ts`) is WS-only on `127.0.0.1:8790`; sessions are
  persona-authenticated by token. There is no HTTP surface and no admin identity.
- `mint-invite.mjs` writes `invites.json` directly (admin-only, file-level, no
  audit).

The machinery to *apply* changes exists; what's missing is an **authenticated,
authorized, audited way to drive it** that isn't "ssh + edit JSON".

## 4. Problem statement

1. No management UI/API — only file edits.
2. No **delegation**: can't let a guild's admins manage that guild's access.
3. No **admin identity / auth**: nothing knows *who* an administrator is.
4. No **audit**: changes are untraceable (demonstrated live).
5. Invites can only **mint**, never **augment** an existing persona.

## 5. Proposed design

### 5.1 Architecture — admin API on the relay, panel as a frontend

```
                          ┌──────────────── relay process ───────────────┐
   Discord OAuth ──login──▶ admin HTTP API (127.0.0.1:8791)              │
                          │   ├─ oauth.ts   (auth-code flow, sessions)    │
   panel (static SPA) ───▶│   ├─ authz.ts   (super-admin + guild-admin)   │
        │  HTTPS          │   ├─ routes.ts  (invites/roles/personas/audit)│
        ▼                 │   └─ audit.ts   (append-only log)             │
     caddy (TLS) ─────────┘        │ reuses ▼                             │
                          │  IdentityStore · PermissionsStore · InviteStore│
                          │  DiscordBot (list_roles / channels / verify)   │
                          │  Gateway (WS 8790) ── capabilities_update push │
                          └───────────────────────────────────────────────┘
```

- **Single writer.** The API calls the same store mutators the relay already
  uses, so admin edits and `enroll` writes serialize in one process — no file
  race. (Direct file editing remains possible but un-audited; see §10.)
- **Localhost + Caddy.** The API binds `127.0.0.1:8791`; only Caddy (already on
  the host) is internet-facing, terminating TLS and proxying. The WS gateway
  (`8790`) is unchanged.
- **Panel = static SPA.** No server-side rendering; it calls the admin API. May
  be served by the API or a separate static host (open question §9).

### 5.2 Discord OAuth2 + sessions

Standard auth-code flow, scopes **`identify guilds`**:

1. Panel → `GET /admin/login` → redirect to Discord with `state` (CSRF).
2. Discord → `GET /admin/callback?code&state` → exchange for a user token.
3. Read `GET /users/@me` (identity) and `GET /users/@me/guilds` — the latter
   returns each guild with a `permissions` bitfield and `owner` flag, so **admin
   guilds are derived directly from the OAuth response** — no per-user bot query.
4. Mint a **server-side session** (httpOnly/secure/sameSite cookie, short TTL);
   store the derived admin-guild set + identity. The user's Discord token is used
   once and discarded (we don't need ongoing Discord calls per request).

### 5.3 Authorization model

- **Super-admin** — a configured list of Discord user ids (`PORTAL_SUPERADMINS`).
  Portal operators; may act in **any** guild and edit the role catalog globally.
- **Guild-admin** — holds `ADMINISTRATOR`, `MANAGE_GUILD`, or ownership in guild
  *G* (per §5.2). May manage objects **scoped to *G*** only.
- **Enforcement is server-side on every mutation.** The client's claimed guild is
  never trusted; the API re-checks the session's admin-guild set. A guild-admin
  may: mint/revoke invites with `guildId == G`; assign/revoke (super-admin-defined)
  roles bound to *G* on personas; **individually grant/edit a persona's
  permissions *within G*** — ad-hoc per-channel or guild-default caps written to
  that persona's `guilds[G]` policy block (`setChannel` / `setGuildDefault`),
  including for personas not yet present in *G* (admin-initiated augmentation,
  §5.6); view personas with access in *G*. Cross-guild attempts → `403`.
  - **Persona token lifecycle is *not* a guild-admin power.** A token is the
    persona's *global* identity credential — revoking/rotating it affects every
    guild, not just *G* — so force-rotate/revoke is **super-admin-only** and lives
    off the guild path (`POST /admin/personas/:id/token`, §5.9). A guild-admin's
    tool for "remove this agent from my guild" is revoking its *G*-scoped
    roles/grants, which is fully within scope.
- **Per-persona grants are strictly clipped to *G*.** A guild-admin's policy edits
  may only touch the `guilds[G]` block and channels whose `guildId == G`; never
  the global `default`, never another guild's block. (Plus the standing
  `∩ Discord reality` ceiling — they can't grant more than the bot can do there.)
- **Guild-admins do *not* author the access-role catalog.** Defining named,
  reusable `roles` is **super-admin-only**. Guild-admins express access the
  Discord-native way: when minting an invite they **mirror their own Discord
  roles** (`mirrorRole(s)`, which they already manage in their server) or pick
  **channels** — so "managing roles" for a server admin happens *in Discord*, and
  portal tracks it. This keeps the abstraction surface (and blast radius) of
  delegated admins small while still giving them full, self-service control.

### 5.4 Admin API surface (scoped, audited)

| Area | Endpoints |
|---|---|
| Invites | `GET/POST /admin/g/:gid/invites`, `DELETE …/invites/:code` (mint/list/revoke; RFC-004 scopes via Discord-role/channel pickers + `mode` §5.6) — **guild-admin** |
| Access roles | `GET /admin/g/:gid/roles` (read, for assignment pickers — **guild-admin**); `POST/DELETE /admin/roles[/:name]` catalog authoring — **super-admin only** (global) |
| Personas (guild-scoped) | `GET …/personas` (access in *G* + effective caps); `POST/DELETE …/personas/:id/roles` (assign/revoke); `PUT/DELETE …/personas/:id/grants` (ad-hoc per-channel/guild-default caps in *G*, §5.3); `POST …/personas/:id/claim` (admin augment §5.6) — **guild-admin** |
| Persona tokens (global) | `POST /admin/personas/:id/token` (rotate/revoke §5.9) — **super-admin only**; not guild-scoped (a token is global identity) |
| Audit | `GET /admin/g/:gid/audit` (read the log, filtered to *G*) — **guild-admin** |

All mutations are audited and CSRF-checked.

Reads reuse `list_roles`, `channelsVisibleToRole`, `couldAccessGuild`,
`capsFor`. Writes reuse `setPersonaRoles` / `InviteStore` / a new roles-catalog
mutator. Every write emits the existing `PermissionChange` so the relay re-pushes
`capabilities_update` to affected live sessions.

### 5.5 Audit log

Append-only records: `{ ts, actor: {discordId, name}, action, target, guildId,
before?, after? }`. Stored as JSONL (or sqlite — open question §9). Written on
every API mutation; **also** on `claim_invite` (actor = the persona). The panel's
Audit tab reads it, guild-filtered.

### 5.6 Self-service rights — invites that augment

`InviteTemplate` gains a **mode**:

```ts
interface InviteTemplate {
  // …RFC-004 fields…
  mode?: 'mint' | 'augment' | 'both';   // default 'mint' (today's behaviour)
}
```

- **`mint`** — current behaviour: a fresh, unauthenticated agent enrolls a new
  persona (`register`).
- **`augment`** — an **authenticated** persona presents the code to *add* the
  invite's roles/grant to itself.
- **`both`** — either.

New authenticated op **`claim_invite { code }`** (only valid on an identified
session): validate (`check` + mode allows augment + not expired/exhausted), then
**union** the invite's roles into `personas[id].roles` (and merge any inline
`grant` into the persona's `policy`), `consume` a use, write an audit record, and
re-push `capabilities_update`. Resolution already unions roles
(`PermissionsStore.resolve`), so the relay change is a small `addPersonaRoles`
mutator + the op handler. Admins can also trigger augment for a persona from the
panel (`…/personas/:id/claim`).

This generalizes invites from "persona factory" to **scoped rights grant** that
can bootstrap a new identity *or* extend an existing one — and since a
guild-admin minted the invite (scoped to *G*), a persona can only ever augment
itself up to what that guild's admin already authorized.

The same augmentation is available **admin-initiated** from the panel: a
guild-admin can grant an existing persona access in *G* directly — by assigning a
*G*-bound role, or writing ad-hoc caps to its `guilds[G]` policy block (§5.3) —
without minting an invite at all. Both paths are bounded to *G* and audited.

### 5.7 Frontend

A static SPA served as plain assets by the **same Caddy on the same box** (Caddy
serves `/` from the build dir and reverse-proxies `/admin/api/*` to the relay on
`:8791` — no relay involvement in asset serving, clean CSP). Discord login; a
**guild switcher limited to the admin's guilds**; tabs **Invites / Personas /
Audit** (+ **Roles** read-only for assignment, editable only for super-admins).
The invite editor offers the guild's **Discord roles** (for `mirrorRole(s)`) and
**channels** (for `channels` scope) as pickers — server admins compose access out
of their own Discord roles. Purely an API client; all authz is server-side (§5.3).

### 5.8 Revocation

Revocation leans on the fact that **caps are re-resolved server-side on every
gated action** (`requireCap` → `capsFor` → `PermissionsStore.resolve`), not just
pushed once at grant time. So role-based grants are *live-revocable*:

- **Unassign a role** (`personas[id].roles -= name`) or **delete/edit a role** in
  the catalog → affected personas lose those caps on their **next action**, and
  the relay re-pushes `capabilities_update`. Effective immediately; no reconnect,
  and a client that ignores the push is still denied server-side.
- **Delete a persona** (`removePersona`) → identity + policy gone, and
  `gateway.closePersona` drops its live sessions at once.
- **Revoking an invite is forward-only** — it stops future `enroll`/`claim` but
  past grants persist (the invite applied at claim time). To retract what an
  invite already handed out, revoke the *roles it assigned*; the **audit log ties
  each persona's roles back to the granting invite/admin**, so the panel can
  offer "revoke everything this invite granted" as a traceable action.
- **Per-persona `policy` grants** (a guild-admin's ad-hoc per-guild caps §5.3, a
  `grant:` invite snapshot, or legacy inline policy) are **also live** — editing
  or clearing the persona's `guilds[G]` block re-resolves on the next action and
  re-pushes `capabilities_update`. The difference from roles is *granularity*, not
  liveness: a **role** revokes in **bulk** (edit once → every assignee loses it),
  a **policy** grant is **per-persona**. Rule of thumb: roles when many personas
  share an access level; per-persona policy when a guild-admin hand-tunes one
  persona inside their guild.

### 5.9 Persona token lifecycle

Tokens are shared secrets in `identity.json`, presented at `identify`. They are
the persona's **global identity credential** — a token authenticates the persona
everywhere, independent of any guild — so admin token operations are **not
guild-scoped**: force-rotate/revoke is **super-admin-only**, at the global
`POST /admin/personas/:id/token` (a guild-admin could otherwise lock a persona
out of guilds they don't administer). Operations split by *who drives it* —
because the hard part is **delivering a new token to the legitimate agent** (the
token *is* the channel):

- **Self-service rotation** — `rotate_token` RPC on an already-authenticated
  session: the relay issues a fresh token **in the response over the live WS**,
  invalidates the old one, and keeps the session up. Delivery is solved (in-band,
  zero downtime). The routine-hygiene path an agent runs on itself. (Available to
  any authenticated persona — it only ever rotates *its own* token.)
- **Admin force-revoke** (super-admin) — invalidates the token and
  `closePersona`s its sessions at once. For a compromised/rogue agent: it can't
  reconnect; recovery is out-of-band (admin rotates + hands over the new token) or
  re-enrollment.
- **Admin force-rotate** (super-admin) — generate a new token, **show it once** in
  the panel for the admin to deliver, invalidate the old, close sessions. For when
  an agent lost its token but should keep its identity + grants.

**Hardening (recommended, pairs naturally with this):** store tokens **hashed**
at rest (compare a hash at `identify`) so a leaked `identity.json` can't be
replayed. It's a breaking change to the identity store + `identify` path — see
§9.1. All three operations are audited (actor + persona + action; never the
secret itself).

## 6. Phasing & effort

| Phase | Items | Effort | Unblocks |
|---|---|---|---|
| **P1 — API skeleton + OAuth** | HTTP server on `:8791`, Discord auth-code flow, sessions, super-admin, read-only views (invites/roles/personas) | ~2–3 d | Authenticated admin reads |
| **P2 — Scoped CRUD + audit** | guild-admin authz, invite mint/revoke + persona role assign/revoke via API, admin token revoke/rotate (§5.9), audit log + tab | ~3–4 d | Delegated self-service management |
| **P3 — Self-service ops + token hardening** | `InviteTemplate.mode` + `claim_invite`, `rotate_token`, `addPersonaRoles`, **hashed-at-rest tokens** (§5.9) | ~2–3 d | Personas grow/rotate without an admin; leaked `identity.json` can't be replayed |
| **P4 — Frontend SPA** | login, guild switcher, Invites/Personas/Audit tabs, Discord-role + channel pickers | ~3–5 d | The actual panel |

P3 is largely independent and could ship ahead of the panel (it's the smallest,
highest-leverage piece). P1–P2 are the security-sensitive core.

## 7. Security considerations

A public-facing admin surface is a materially bigger attack surface than the
localhost WS gateway. Non-negotiables:

- **Network**: admin API binds `127.0.0.1` only; **Caddy** is the sole exposed
  endpoint, TLS-terminating. No direct `:8791` exposure.
- **OAuth**: `state` CSRF param, strict `redirect_uri` allowlist, minimal scopes
  (`identify guilds`), discard the user token after deriving admin guilds.
- **Sessions**: server-side store, httpOnly/secure/sameSite cookies, short TTL,
  rotation on privilege change; CSRF tokens on mutations.
- **Authz server-side, always**: re-derive admin guilds from the session; never
  trust a client-supplied `guildId`. Cross-guild action → `403`.
- **Permission staleness**: an admin who loses Discord rights must lose panel
  rights — re-derive on login and on a periodic/short session TTL (same
  fail-closed posture as the mirror cache in RFC-004).
- **Audit everything**, including failed authz attempts.
- **Rate-limit** OAuth callbacks, `mint`, and `claim_invite`.
- **Invites stay bearer credentials**, and **augmentation widens blast radius**
  (a leaked `augment`/`both` code can escalate *any* persona whose token is
  known): default `mode: 'mint'`, augment is opt-in, scoped to the minting
  guild, capped (`maxUses`/`expiresAt`), and rate-limited.
- **Super-admin list is high-value** — keep it in deploy config, not the panel.
- The admin API can do **far more** than the gateway; it must be a distinct,
  separately-hardened module, not bolted onto the WS auth path.

## 8. Testing

- **Unit**: authz scoping (guild-admin *G* cannot read/mutate *H*); admin-guild
  derivation from a fake `guilds` payload (`ADMINISTRATOR`/`MANAGE_GUILD`/owner/
  none); `claim_invite` union + `mode` enforcement (mint-only code rejects
  augment); audit record shape; super-admin override.
- **Integration (mocked Discord)**: full OAuth round-trip → session → scoped
  mint → `enroll` → `claim_invite` augment → `capabilities_update` observed.
- **Adversarial**: cross-guild escalation attempts, forged/expired sessions,
  expired/exhausted invites, augment with a `mint`-only code, redirect_uri
  tampering, `state` replay.

## 9. Decisions & open questions

**Resolved (this round):**
- **Frontend** — static assets served by the **same Caddy on the same box**; API
  proxied to the relay (§5.7).
- **Audit storage** — **JSONL** (§5.5).
- **Role authoring** — the named access-role **catalog is super-admin-only**;
  guild-admins author *invites* and express access by mirroring their **Discord
  roles** / picking channels ("roles via Discord", §5.3).
- **OAuth app** — **one per deployment** (one server, one OAuth app); cross-server
  *syndication* is a later concern.
- **Revocation** — designed in §5.8: both roles and per-persona policy are
  live-revocable (server-side re-resolution on every action); roles revoke in
  bulk, policy per-persona; invite revocation is forward-only with an
  audit-traced "revoke what it granted".
- **Hashed-at-rest tokens** — **yes, now**, as part of P3 (§5.9). Migrate while
  the persona count is small (2 today, dozens within the week); cheaper before
  more tokens accumulate than after.
- **Hashed-token migration mechanics** — **forced rotation at cutover, no legacy
  path**. All existing tokens are rotated to fresh, hashed-at-rest secrets at the
  cutover and redelivered out-of-band; we do **not** keep a lazy rehash-on-next-
  `identify` fallback (which would leave plaintext in `identity.json` until each
  persona reconnects, partially defeating the "leaked file can't be replayed"
  goal). Clean and cheap at today's persona count; `identify` only ever compares
  hashes after cutover.
- **Per-persona grants by guild-admins** — supported (§5.3): a guild-admin may
  write ad-hoc caps to a persona's `guilds[G]` block, strictly clipped to *G*.

**Still open:**

1. **`rotate_token` exposure** — always available to any authenticated persona,
   or gate-able / disable-able per deployment?
2. **Rate-limit thresholds** for `claim_invite` / `mint` / OAuth callbacks.

## 10. Backward compatibility

- **Additive.** The stores, files, and `mint-invite.mjs` keep working. The admin
  API is *another path to the same in-process mutators*, so it doesn't conflict
  with the relay's own writes.
- **Direct file editing still works** (hot-reload) but is **un-audited and can
  race** the relay's writes — a pre-existing hazard. Recommend: for managed
  deployments, route changes through the API (audited, serialized) and treat
  hand-editing as break-glass. (This directly addresses the out-of-band edit that
  motivated the RFC.)
- **`mode` defaults to `'mint'`** — existing invites behave exactly as today.
- **No wire break**: `claim_invite` is an additive op (minor `portal-protocol`
  bump); existing `register`/`identify`/RPC are unchanged.
