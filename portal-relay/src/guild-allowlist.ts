/**
 * Guild allow-list store — the runtime-editable set of Discord guilds the
 * relay serves. Backed by a JSON file (PORTAL_GUILDS) with the same
 * WatchedFile hot-reload + self-write suppression as the other stores.
 *
 * Semantics: when this store is active, an EMPTY list means DENY ALL (fail
 * closed — a UI removal of the last guild must not open the relay to every
 * guild the bot is in). The legacy env path (DISCORD_GUILD_ID, no store)
 * keeps its historical empty ⇒ allow-all behaviour; see Relay's accessor.
 *
 * First boot: if the file doesn't exist it is seeded from the DISCORD_GUILD_ID
 * snapshot, so enabling PORTAL_GUILDS on an existing deployment is a no-op
 * migration and the env var remains a re-seed safety net.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { WatchedFile } from './file-watch.js';

export interface GuildAllowFile {
  guildIds: string[];
}

export interface GuildAllowChange {
  added: string[];
  removed: string[];
}

export class GuildAllowStore {
  private ids = new Set<string>();
  private file?: WatchedFile;
  private listeners: Array<(c: GuildAllowChange) => void> = [];

  constructor(
    private path: string,
    seed: string[] = [],
  ) {
    if (!existsSync(path)) {
      this.ids = new Set(seed);
      this.persist();
      console.error(`[portal-relay] seeded guild allow-list ${path} (${this.ids.size} guilds)`);
      if (this.ids.size === 0) {
        console.error(
          '[portal-relay] WARNING: guild allow-list is EMPTY — relay will ignore ALL guilds (deny-all). ' +
            'Add guilds via the admin panel.',
        );
      }
    } else {
      this.load();
    }
  }

  onChange(fn: (c: GuildAllowChange) => void): void {
    this.listeners.push(fn);
  }

  startWatching(): void {
    this.file = new WatchedFile(this.path, () => this.reload());
    this.file.start();
  }

  stopWatching(): void {
    this.file?.stop();
  }

  list(): string[] {
    return [...this.ids];
  }

  has(id: string): boolean {
    return this.ids.has(id);
  }

  // ── Mutations (persist + emit) — admin API ──

  /** Allow a guild. Returns false (no write, no emit) if already present. */
  allow(id: string): boolean {
    if (this.ids.has(id)) return false;
    this.ids.add(id);
    this.persist();
    this.emit({ added: [id], removed: [] });
    return true;
  }

  /** Disallow a guild. Returns false (no write, no emit) if absent. */
  disallow(id: string): boolean {
    if (!this.ids.delete(id)) return false;
    this.persist();
    this.emit({ added: [], removed: [id] });
    return true;
  }

  // ── File IO ──

  private load(): void {
    const next = JSON.parse(readFileSync(this.path, 'utf8')) as GuildAllowFile;
    if (!Array.isArray(next.guildIds) || next.guildIds.some((g) => typeof g !== 'string')) {
      throw new Error('guild allow-list file: guildIds must be an array of strings');
    }
    this.ids = new Set(next.guildIds);
  }

  /** Hot-reload on external edit: re-read, diff, emit the net change. */
  private reload(): void {
    const before = this.ids;
    this.load();
    const added = [...this.ids].filter((id) => !before.has(id));
    const removed = [...before].filter((id) => !this.ids.has(id));
    this.emit({ added, removed });
  }

  private persist(): void {
    const data: GuildAllowFile = { guildIds: this.list() };
    const json = JSON.stringify(data, null, 2) + '\n';
    if (this.file) this.file.write(json);
    else writeFileSync(this.path, json);
  }

  private emit(c: GuildAllowChange): void {
    if (!c.added.length && !c.removed.length) return;
    for (const fn of this.listeners) fn(c);
  }
}
