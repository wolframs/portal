// The daily cap: before a paid call, today's (UTC) catalogue dollars for the
// route are summed from its spend file; at or over daily_usd — or after the
// marketplace answered 402 today — the persona holds until 00:00 UTC. Each
// channel hears the notice once per UTC day. Hold and notice state live in
// <spendDir>/<route>.state.json so a restart neither re-notifies a channel
// nor re-tries a key Surplus has already refused today.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spentToday, toStderr, utcDay } from './meter.mjs';

export const HOLD_NOTICE = 'Daily model budget reached; back at 00:00 UTC.';

export class BudgetGate {
  /** @param {{ dir: string, route: string, dailyUsd: number|null, now?: () => Date, warn?: Function }} opts */
  constructor({ dir, route, dailyUsd, now = () => new Date(), warn = toStderr }) {
    this.dir = dir;
    this.route = route;
    this.dailyUsd = dailyUsd;
    this.now = now;
    this.warn = warn;
    this.file = join(dir, `${route}.state.json`);
  }

  /** The UTC day it is now — the day a check or notice belongs to. */
  today() {
    return utcDay(this.now());
  }

  read() {
    try {
      return JSON.parse(readFileSync(this.file, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') this.warn(`unreadable ${this.file} (${e.message}); starting today's state fresh`);
      return null;
    }
  }

  /** The state for `day` (default today); anything stamped with another day
   *  is the reset. */
  state(day = this.today(), s = this.read()) {
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

  needsNotice(channel, day = this.today()) {
    return !this.state(day).noticed.includes(channel);
  }

  /** Record that `channel` heard `day`'s notice. Pass the day the notice was
   *  decided on: a send that finishes after 00:00 UTC still belongs to the
   *  old day, and must not mark the new one (which may yet need its own). */
  markNoticed(channel, day = this.today()) {
    const stored = this.read();
    if (stored && typeof stored.day === 'string' && stored.day > day) return; // that day is over
    const s = this.state(day, stored);
    if (!s.noticed.includes(channel)) s.noticed.push(channel);
    this.save(s);
  }
}
