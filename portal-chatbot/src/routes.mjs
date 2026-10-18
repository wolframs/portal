// Route table: which model a persona talks to, where, with which key, and what
// it may cost. One JSON file (CHATBOT_ROUTES), one route per persona process
// (CHATBOT_ROUTE). With no route set the persona keeps the original OpenRouter
// behaviour, configured by the OPENROUTER_* variables (legacyRoute).
//
// File shape (see routes.example.json):
//   { "defaults": { ...route fields... },
//     "routes": { "<name>": { ...route fields... } } }
// Keys starting with "_" are comments and ignored at any level.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_ROUTES_PATH = join(homedir(), 'Projects', 'portal-runtime', 'routes.json');
export const DEFAULT_CONTEXT_CHARS = 75000;

/** Request-body fields a route may add verbatim (Surplus routing controls). */
export const EXTRA_KEYS = ['provider', 'providers_blocked', 'provider_order', 'si_route'];

/** Never sent, whatever a route's allowlist says: this persona is text only,
 *  with no tools, and SI strips include_reasoning on the chat wire. */
export const NEVER_SEND = [
  'tools', 'tool_choice', 'functions', 'function_call', 'parallel_tool_calls',
  'audio', 'modalities', 'include_reasoning', 'messages', 'model', 'stream',
];

const ROUTE_KEYS = new Set([
  'model', 'base_url', 'key_env', 'key_file', 'extra', 'max_tokens', 'context_chars',
  'daily_usd', 'usd_per_mtok', 'allowed_params', 'params',
]);
const PRICE_KEYS = ['prompt', 'completion', 'cache_read', 'cache_write'];

export const expandHome = (p) => (typeof p === 'string' && p.startsWith('~/') ? join(homedir(), p.slice(2)) : p);

const strip = (obj) =>
  Object.fromEntries(Object.entries(obj ?? {}).filter(([k]) => !k.startsWith('_')));

/** Load and validate one named route. Throws with a message naming the file,
 *  route and field on any mistake — a persona must not start half-configured. */
export function loadRoute(path, name) {
  let table;
  try {
    table = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`routes file ${path}: ${e.message}`);
  }
  const routes = strip(table.routes);
  if (!Object.hasOwn(routes, name)) {
    throw new Error(`routes file ${path} has no route "${name}" (has: ${Object.keys(routes).join(', ') || 'none'})`);
  }
  return resolveRoute(name, strip(table.defaults), strip(routes[name]), path);
}

export function resolveRoute(name, defaults, own, where = 'routes') {
  const at = `${where} route "${name}"`;
  for (const k of [...Object.keys(defaults), ...Object.keys(own)]) {
    if (!ROUTE_KEYS.has(k)) throw new Error(`${at}: unknown field "${k}"`);
  }
  const r = { ...defaults, ...own };
  // extra and params merge one level deep, so a route can add to the defaults.
  const extra = { ...strip(defaults.extra), ...strip(own.extra) };
  const params = { ...strip(defaults.params), ...strip(own.params) };

  if (typeof r.model !== 'string' || !r.model) throw new Error(`${at}: "model" is required`);
  if (typeof r.base_url !== 'string' || !/^https?:\/\//.test(r.base_url)) {
    throw new Error(`${at}: "base_url" must be an http(s) URL`);
  }
  if (typeof r.key_env !== 'string' || !r.key_env) throw new Error(`${at}: "key_env" is required`);
  for (const k of Object.keys(extra)) {
    if (!EXTRA_KEYS.includes(k)) throw new Error(`${at}: extra field "${k}" is not one of ${EXTRA_KEYS.join(', ')}`);
  }
  const maxTokens = r.max_tokens ?? 2048;
  const contextChars = r.context_chars ?? DEFAULT_CONTEXT_CHARS;
  for (const [k, v] of [['max_tokens', maxTokens], ['context_chars', contextChars]]) {
    if (!Number.isInteger(v) || v <= 0) throw new Error(`${at}: "${k}" must be a positive integer`);
  }
  const daily = r.daily_usd ?? null;
  if (daily !== null && !(typeof daily === 'number' && daily >= 0)) {
    throw new Error(`${at}: "daily_usd" must be a non-negative number`);
  }
  const price = r.usd_per_mtok ? strip(r.usd_per_mtok) : null;
  if (daily !== null && !price) throw new Error(`${at}: a "daily_usd" cap needs "usd_per_mtok" prices`);
  if (price) {
    for (const k of Object.keys(price)) {
      if (!PRICE_KEYS.includes(k)) throw new Error(`${at}: usd_per_mtok field "${k}" is not one of ${PRICE_KEYS.join(', ')}`);
      if (!(typeof price[k] === 'number' && price[k] >= 0)) throw new Error(`${at}: usd_per_mtok.${k} must be a non-negative number`);
    }
    if (price.prompt === undefined || price.completion === undefined) {
      throw new Error(`${at}: usd_per_mtok needs at least "prompt" and "completion"`);
    }
  }
  const allowed = r.allowed_params ?? ['max_tokens'];
  if (!Array.isArray(allowed) || allowed.some((p) => typeof p !== 'string')) {
    throw new Error(`${at}: "allowed_params" must be a list of parameter names`);
  }
  const banned = allowed.filter((p) => NEVER_SEND.includes(p));
  if (banned.length) throw new Error(`${at}: allowed_params may not include ${banned.join(', ')} (text-only persona)`);
  const refused = Object.keys(params).filter((p) => !allowed.includes(p));
  if (refused.length) throw new Error(`${at}: params ${refused.join(', ')} are not in allowed_params for ${r.model}`);
  if (Object.hasOwn(params, 'max_tokens')) throw new Error(`${at}: set "max_tokens" as a route field, not in params`);

  return {
    name,
    model: r.model,
    baseUrl: r.base_url.replace(/\/+$/, ''),
    keyEnv: r.key_env,
    keyFile: expandHome(r.key_file) ?? null,
    extra,
    maxTokens,
    contextChars,
    dailyUsd: daily,
    price, // USD per million tokens, or null (unmetered)
    allowedParams: allowed,
    params,
  };
}

/** The original behaviour: OpenRouter, model and provider object from env, no
 *  meter and no cap. Used when CHATBOT_ROUTE is unset. */
export function legacyRoute(env) {
  return {
    name: null,
    model: env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4-pro',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyEnv: 'OPENROUTER_API_KEY',
    keyFile: null,
    // OpenRouter's provider-routing object, passed through verbatim as before.
    extra: env.OPENROUTER_PROVIDER ? { provider: JSON.parse(env.OPENROUTER_PROVIDER) } : {},
    maxTokens: Number(env.CHATBOT_MAX_TOKENS ?? '1024'),
    contextChars: Number(env.CHATBOT_CONTEXT_CHARS ?? DEFAULT_CONTEXT_CHARS),
    dailyUsd: null,
    price: null,
    allowedParams: ['max_tokens'],
    params: {},
  };
}

/** Minimal dotenv reader: KEY=VALUE lines, optional `export `, optional quotes. */
export function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** The route's API key: the environment variable wins; otherwise the route's
 *  key_file (a dotenv file) is read for the same variable name. */
export function resolveKey(route, env, readFile = (p) => readFileSync(p, 'utf8')) {
  if (env[route.keyEnv]) return env[route.keyEnv];
  if (route.keyFile) {
    let text;
    try {
      text = readFile(route.keyFile);
    } catch (e) {
      throw new Error(`${route.keyEnv} is not set and key_file ${route.keyFile} is unreadable: ${e.message}`);
    }
    const v = parseEnvFile(text)[route.keyEnv];
    if (v) return v;
    throw new Error(`${route.keyEnv} is not set and key_file ${route.keyFile} does not define it`);
  }
  throw new Error(`${route.keyEnv} is required`);
}
