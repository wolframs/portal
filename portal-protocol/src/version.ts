/**
 * Protocol version. Bumped on any breaking change to frames, events, or RPC.
 * The relay sends it in `hello`; clients send it in `identify`. A relay MAY
 * refuse an `identify` whose version it can't speak (→ `invalid_session`,
 * `resumable: false`).
 */
// v2 (RFC-005): additive `claim_invite` + `rotate_token` RPC methods. Backward
// compatible — older clients simply never call them; the relay does not refuse a
// lower client version.
export const PORTAL_PROTOCOL_VERSION = 2 as const;

export type ProtocolVersion = typeof PORTAL_PROTOCOL_VERSION;
