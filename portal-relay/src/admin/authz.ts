/**
 * Authorization model (RFC-005 §5.3). Two roles:
 *   - super-admin: configured operator; may act in ANY guild.
 *   - guild-admin: derived from live Discord perms; may act only in guilds they
 *     administer.
 *
 * Enforcement is server-side on every request: the client's claimed guild is
 * never trusted — we re-check the session's derived admin-guild set.
 */
import type { AdminSession } from './sessions.js';

/** May this session manage `guildId`? Super-admins always may. */
export function canManageGuild(session: AdminSession, guildId: string): boolean {
  return session.isSuper || session.adminGuilds.has(guildId);
}

/** Catalog authoring (named access roles) is super-admin-only (RFC-005 §5.3). */
export function canAuthorRoles(session: AdminSession): boolean {
  return session.isSuper;
}
