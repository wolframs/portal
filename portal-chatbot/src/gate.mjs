// The daily cap: before a paid call, today's (UTC) catalogue dollars for the
// route are summed from its spend file; at or over daily_usd — or after the
// marketplace answered 402 today — the persona holds until 00:00 UTC. Each
// channel hears the notice once per UTC day. Hold and notice state live in
// <spendDir>/<route>.state.json so a restart neither re-notifies a channel
// nor re-tries a key Surplus has already refused today.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spentToday, utcDay } from './meter.mjs';

export const HOLD_NOTICE = 'Daily model budget reached; back at 00:00 UTC.';

export class BudgetGate {
  /** @param {{ dir: string, route: string, dailyUsd: number|null, now?: () => Date, warn?: Function }} opts */
  constructor({ dir, route, dailyUsd, now = () => new Date(), warn = () => {} }) {
    this.dir = dir;
    this.route = route;
    this.dailyUsd = dailyUsd;
    this.now = now;
    this.warn = warn;
    this.file = join(dir, `${route}.state.json`);
  }

  /** Today's state; anything stamped with an earlier day is the reset. */
  state() {
    const day = utcDay(this.now());
    let s;
    try {
      s = JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.warn(`unreadable ${this.file} (${e.message}); starting today's state fresh`);
    }
    if (!s || s.day !== day) return { day, held: null, noticed: [] };
    return { day, held: s.held ?? null, noticed: Array.isArray(s.noticed) ? s.noticed : [] };
  }

  save(s) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(s) + '\n');
    renameSync(tmp, this.file);
  }

  spent() {
    return spentToday(this.dir, this.route, this.now(), this.warn);
  }

  /** Why the route is holding today, or null if it may answer. */
  holdReason() {
    const s = this.state();
    if (s.held) return s.held;
    if (this.dailyUsd !== null) {
      const spent = this.spent();
      if (spent >= this.dailyUsd) return `daily cap $${this.dailyUsd} reached ($${spent.toFixed(4)} today)`;
    }
    return null;
  }

  /** Record a marketplace refusal (402): hold for the rest of the UTC day. */
  hold(reason) {
    const s = this.state();
    s.held = reason;
    this.save(s);
  }

  needsNotice(channel) {
    return !this.state().noticed.includes(channel);
  }

  markNoticed(channel) {
    const s = this.state();
    if (!s.noticed.includes(channel)) s.noticed.push(channel);
    this.save(s);
  }
}
