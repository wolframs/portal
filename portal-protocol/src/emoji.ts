import type { GuildId } from './ids.js';

/**
 * A custom (server) emoji the relay can see and a persona can use — the shared
 * palette for BOTH message content and reactions (Discord draws both from the
 * same emoji set). `token` renders it in a message; `reactionArg` reacts with
 * it. Populated from the relay's guild emoji cache (GuildEmojisAndStickers
 * intent).
 */
export interface PortalEmoji {
  id: string;
  name: string;
  animated: boolean;
  guildId: GuildId;
  /** The guild's name, if cached; null otherwise. */
  guildName: string | null;
  /** Paste into message content to render it ('<:name:id>' / '<a:name:id>'). */
  token: string;
  /** Pass to `react` to react with it (':name:'). */
  reactionArg: string;
}
