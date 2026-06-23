/**
 * Server-side admin sessions (RFC-005 §5.2, §7). The cookie carries only an
 * opaque id; everything authoritative — identity, the derived admin-guild set,
 * super-admin flag, CSRF token — lives here, server-side. Short TTL so an admin
 * who loses Discord rights loses panel rights on the next login (admin rights are
 * re-derived from Discord at every login, never refreshed mid-session).
 *
 * Also holds short-lived OAuth `state` values for CSRF protection of the
 * login→callback round-trip.
 */
import { randomBytes } from 'node:crypto';

export interface AdminSession {
  id: string;
  userId: string;
  userName: string;
  /** Guilds this admin may manage (super-admins may manage any — see isSuper). */
  adminGuilds: Set<string>;
  /** id → name for the admin's guilds, for the panel switcher. */
  guildNames: Record<string, string>;
  isSuper: boolean;
  /** Double-submit CSRF token; required on mutating requests (P2+). */
  csrf: string;
  createdAt: number;
  expiresAt: number;
}

export class SessionStore {
  private sessions = new Map<string, AdminSession>();
  private states = new Map<string, number>(); // state → expiresAt
  private sweepTimer?: ReturnType<typeof setInterval>;

  constructor(
    private ttlMs: number,
    private now: () => number = () => Date.now(),
  ) {}

  /** Start the periodic expiry sweep (no-op timer unref so it never blocks exit). */
  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), Math.min(this.ttlMs, 60_000));
    this.sweepTimer.unref?.();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  // ── OAuth state (CSRF for the login redirect) ──

  issueState(): string {
    const s = token();
    this.states.set(s, this.now() + 10 * 60_000); // 10 min to complete login
    return s;
  }

  /** Validate-and-consume a state value (single use). */
  consumeState(state: string | undefined): boolean {
    if (!state) return false;
    const exp = this.states.get(state);
    if (exp === undefined) return false;
    this.states.delete(state);
    return exp > this.now();
  }

  // ── Sessions ──

  create(input: Omit<AdminSession, 'id' | 'csrf' | 'createdAt' | 'expiresAt'>): AdminSession {
    const t = this.now();
    const s: AdminSession = {
      ...input,
      id: token(),
      csrf: token(),
      createdAt: t,
      expiresAt: t + this.ttlMs,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string | undefined): AdminSession | undefined {
    if (!id) return undefined;
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (s.expiresAt <= this.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return s;
  }

  destroy(id: string | undefined): void {
    if (id) this.sessions.delete(id);
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (s.expiresAt <= t) this.sessions.delete(id);
    for (const [s, exp] of this.states) if (exp <= t) this.states.delete(s);
  }
}

function token(): string {
  return randomBytes(32).toString('base64url');
}
