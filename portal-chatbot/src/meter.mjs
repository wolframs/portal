// The meter: catalogue dollars per call, one JSON line per call in
// <spendDir>/<route>.jsonl, and today's (UTC) total for the cap.
//
// These are catalogue figures (list price × tokens by kind), not what the
// marketplace billed: a /min70 call is counted at full catalogue rates.
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Normalise a reported `usage` object to disjoint counts:
 *    fresh  — input tokens neither read from nor written to cache
 *    read   — cache-read input tokens
 *    write  — cache-write input tokens
 *    output — completion tokens (reasoning tokens are inside these)
 *  Returns null when the usage does not carry both an input and an output
 *  count — the caller then charges the no-usage estimate.
 *
 *  Conventions: on the OpenAI shape `prompt_tokens` INCLUDES
 *  `prompt_tokens_details.cached_tokens` (and OpenRouter's
 *  `prompt_tokens_details.cache_write_tokens`), so those are subtracted. The
 *  Anthropic-style top-level `cache_read_input_tokens` /
 *  `cache_creation_input_tokens` are disjoint from the input count and are
 *  added, not subtracted — if a server meant them inclusively this
 *  over-counts, which is the safe direction for a cap. */
export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = num(usage.prompt_tokens) ?? num(usage.input_tokens);
  const output = num(usage.completion_tokens) ?? num(usage.output_tokens);
  if (input === undefined || output === undefined) return null;
  const details = usage.prompt_tokens_details ?? usage.input_tokens_details ?? {};
  const inclRead = num(details.cached_tokens) ?? 0;
  const inclWrite = num(details.cache_write_tokens) ?? 0;
  const topRead = num(usage.cache_read_input_tokens) ?? 0;
  const topWrite = num(usage.cache_creation_input_tokens) ?? 0;
  // Never let an inclusive subtraction drive fresh input below zero.
  const fresh = Math.max(0, input - inclRead - inclWrite);
  return { fresh, read: inclRead + topRead, write: inclWrite + topWrite, output };
}

/** Catalogue dollars for a call. `price` is USD per million tokens. A missing
 *  cache price falls back to the prompt price (never to free). With no usable
 *  usage the call is charged as if it used the whole reply budget plus the
 *  sent prompt at ~3 characters per token. */
export function callDollars(price, usage, { maxTokens, promptChars }) {
  const p = (k) => (price[k] ?? price.prompt) / 1e6;
  const n = normalizeUsage(usage);
  if (!n) {
    return {
      dollars: maxTokens * p('completion') + Math.ceil(promptChars / 3) * p('prompt'),
      estimated: true,
      tokens: null,
    };
  }
  return {
    dollars: n.fresh * p('prompt') + n.read * p('cache_read') + n.write * p('cache_write') + n.output * p('completion'),
    estimated: false,
    tokens: n,
  };
}

export const spendFile = (dir, route) => join(dir, `${route}.jsonl`);
export const utcDay = (date) => date.toISOString().slice(0, 10);

export function appendSpend(dir, route, entry) {
  const file = spendFile(dir, route);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(entry) + '\n');
}

/** Sum of `dollars` over the route's entries stamped on the same UTC day as
 *  `now`. A missing file is zero; an unreadable line is skipped with a warning
 *  (a torn last line must not stop the persona). */
export function spentToday(dir, route, now = new Date(), warn = () => {}) {
  let text;
  try {
    text = readFileSync(spendFile(dir, route), 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return 0;
    throw e;
  }
  const day = utcDay(now);
  let total = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      warn(`unreadable spend line in ${spendFile(dir, route)}: ${line.slice(0, 80)}`);
      continue;
    }
    if (typeof e.ts === 'string' && e.ts.slice(0, 10) === day && typeof e.dollars === 'number') total += e.dollars;
  }
  return total;
}
