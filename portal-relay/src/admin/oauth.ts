/**
 * Discord OAuth2 (auth-code flow) for the admin panel (RFC-005 §5.2).
 *
 * We request the minimal `identify guilds` scopes. The crucial trick: the
 * `/users/@me/guilds` response carries a `permissions` bitfield + `owner` flag
 * per guild, so the set of guilds an admin may manage is derived *directly from
 * the OAuth response* — no per-user bot query. The user's Discord token is used
 * once (here) and discarded; we never store it.
 */

/** Discord permission bits we treat as "is an admin of this guild". */
const PERM_ADMINISTRATOR = 0x8n;
const PERM_MANAGE_GUILD = 0x20n;

export const OAUTH_SCOPES = 'identify guilds';
const AUTHORIZE_URL = 'https://discord.com/oauth2/authorize';
const TOKEN_URL = 'https://discord.com/api/oauth2/token';
const API_BASE = 'https://discord.com/api';

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
}

/** One entry of `GET /users/@me/guilds`. */
export interface PartialGuild {
  id: string;
  name: string;
  owner?: boolean;
  /** Permissions bitfield as a decimal string (Discord serialises it so). */
  permissions?: string;
}

export interface OAuthResult {
  user: DiscordUser;
  /** Guild ids the user may administer (owner / ADMINISTRATOR / MANAGE_GUILD). */
  adminGuilds: string[];
  /** Name lookup for the admin guilds (id → name), for the panel switcher. */
  guildNames: Record<string, string>;
}

/** Build the Discord authorize URL the browser is redirected to at /login. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH_SCOPES,
    state,
    prompt: 'none',
  });
  return `${AUTHORIZE_URL}?${q.toString()}`;
}

/**
 * Pure derivation: which guilds may this user administer? Owner, ADMINISTRATOR,
 * or MANAGE_GUILD all qualify (RFC-005 §5.3). Malformed permission strings are
 * treated as no-permission (fail-closed). Exported for direct unit testing.
 */
export function deriveAdminGuilds(guilds: PartialGuild[]): { ids: string[]; names: Record<string, string> } {
  const ids: string[] = [];
  const names: Record<string, string> = {};
  for (const g of guilds) {
    if (!g || typeof g.id !== 'string') continue;
    let admin = g.owner === true;
    if (!admin && typeof g.permissions === 'string') {
      let bits = 0n;
      try {
        bits = BigInt(g.permissions);
      } catch {
        bits = 0n; // unparseable → fail-closed
      }
      admin = (bits & PERM_ADMINISTRATOR) !== 0n || (bits & PERM_MANAGE_GUILD) !== 0n;
    }
    if (admin) {
      ids.push(g.id);
      if (typeof g.name === 'string') names[g.id] = g.name;
    }
  }
  return { ids, names };
}

/** Injectable fetch — lets tests run the callback flow without real network. */
export type FetchLike = typeof fetch;

/**
 * Exchange the auth code for a user token, read identity + guilds, and derive the
 * admin-guild set. The user token is local to this call and discarded on return.
 */
export async function completeOAuth(
  opts: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
  },
  fetchImpl: FetchLike = fetch,
): Promise<OAuthResult> {
  const body = new URLSearchParams({
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    grant_type: 'authorization_code',
    code: opts.code,
    redirect_uri: opts.redirectUri,
  });
  const tokenRes = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!tokenRes.ok) {
    throw new Error(`oauth token exchange failed: ${tokenRes.status}`);
  }
  const tok = (await tokenRes.json()) as { access_token?: string; token_type?: string };
  if (!tok.access_token) throw new Error('oauth token exchange: no access_token');
  const auth = `${tok.token_type ?? 'Bearer'} ${tok.access_token}`;

  const [user, guilds] = await Promise.all([
    apiGet<DiscordUser>(`${API_BASE}/users/@me`, auth, fetchImpl),
    apiGet<PartialGuild[]>(`${API_BASE}/users/@me/guilds`, auth, fetchImpl),
  ]);
  if (!user?.id) throw new Error('oauth: malformed /users/@me');

  const derived = deriveAdminGuilds(Array.isArray(guilds) ? guilds : []);
  return { user, adminGuilds: derived.ids, guildNames: derived.names };
}

async function apiGet<T>(url: string, auth: string, fetchImpl: FetchLike): Promise<T> {
  const res = await fetchImpl(url, { headers: { authorization: auth } });
  if (!res.ok) throw new Error(`oauth GET ${url} failed: ${res.status}`);
  return (await res.json()) as T;
}
