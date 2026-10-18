#!/usr/bin/env node
// portal-chatbot — a generic Portal chat persona backed by an OpenAI-compatible
// model endpoint: a Surplus Intelligence route from the route table, or
// OpenRouter when no route is set.
//
// @-mention the persona (or reply to it) and it answers, with the channel's
// recent history as context. It holds no Discord bot token and uses no
// integration slot: it self-enrolls a tokenless persona from a Portal invite
// and talks only to the relay over WebSocket (same pattern as portal-makeaudio).
//
// Long replies are handled by the relay's markdown-preserving split sends
// (RFC-006) — the bot just sends; parts and bridges are the relay's business.
//
// Environment (README.md has the route table and how to add a persona):
//   CHATBOT_ROUTE         Route name in the route table (e.g. argon). Unset:
//                         the OpenRouter path below, unmetered and uncapped.
//   CHATBOT_ROUTES        Route table path (default ~/Projects/portal-runtime/routes.json).
//   CHATBOT_SPEND_DIR     Spend ledger + hold state (default ~/Projects/portal-runtime/spend).
//   <route key_env>       The route's API key, or read from the route's key_file.
//   OPENROUTER_API_KEY    Required when no route is set.
//   OPENROUTER_MODEL      Model id without a route (default deepseek/deepseek-v4-pro).
//   OPENROUTER_PROVIDER   Optional JSON provider-routing object without a route,
//                         passed through verbatim (e.g. '{"order":["deepinfra"],"allow_fallbacks":false}').
//   CHATBOT_CONTEXT_CHARS Context window in characters without a route (default 75000);
//                         a route sets its own context_chars.
//   CHATBOT_MAX_TOKENS    Reply budget without a route (default 1024).
//   CHATBOT_HISTORY       Most messages read back to fill the window (default 500).
//   PORTAL_URL            Relay WS url (default ws://127.0.0.1:8790).
//   PORTAL_INVITE         Invite code for first-run enrollment.
//   PORTAL_PERSONA_NAME   Desired persona name (default "DeepSeek").
//   PORTAL_CREDENTIALS    Creds cache path (default ~/.portal/chatbot.creds.json).
//   CHATBOT_SYSTEM_PROMPT       Inline system prompt, or
//   CHATBOT_SYSTEM_PROMPT_FILE  path to one (file wins; both optional).
//   CHATBOT_BOT_CHAIN_CAP Max consecutive replies to non-human authors per
//                         channel before going quiet until a human speaks
//                         (default 6; loop brake for bot⇄bot ping-pong).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PortalClient, loadOrEnrollCreds } from '../../portal-client/dist/src/index.js';
import { BudgetGate } from './gate.mjs';
import { complete } from './llm.mjs';
import { DEFAULT_ROUTES_PATH, expandHome, legacyRoute, loadRoute, resolveKey } from './routes.mjs';
import { authorName, fetchForWindow, isHuman } from './transcript.mjs';
import { answer, serial } from './turn.mjs';

const log = (...a) => console.log('[chatbot]', ...a);
const warn = (...a) => console.warn('[chatbot]', ...a);

const ROUTE_NAME = process.env.CHATBOT_ROUTE || null;
const ROUTES_PATH = expandHome(process.env.CHATBOT_ROUTES) || DEFAULT_ROUTES_PATH;
const SPEND_DIR = expandHome(process.env.CHATBOT_SPEND_DIR) || join(homedir(), 'Projects', 'portal-runtime', 'spend');
const URL_WS = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
const INVITE = process.env.PORTAL_INVITE;
const PERSONA_NAME = process.env.PORTAL_PERSONA_NAME ?? 'DeepSeek';
const CREDS_PATH = process.env.PORTAL_CREDENTIALS ?? join(homedir(), '.portal', 'chatbot.creds.json');
const HISTORY_MAX = Number(process.env.CHATBOT_HISTORY ?? '500');
const BOT_CHAIN_CAP = Number(process.env.CHATBOT_BOT_CHAIN_CAP ?? '6');

let ROUTE;
let API_KEY;
try {
  ROUTE = ROUTE_NAME ? loadRoute(ROUTES_PATH, ROUTE_NAME) : legacyRoute(process.env);
  API_KEY = resolveKey(ROUTE, process.env);
} catch (e) {
  console.error(`[chatbot] ${e.message}`);
  process.exit(2);
}
const MODEL = ROUTE.model;
// A route with prices is metered; with a daily_usd it is also capped.
const GATE = ROUTE.name && ROUTE.price
  ? new BudgetGate({ dir: SPEND_DIR, route: ROUTE.name, dailyUsd: ROUTE.dailyUsd, warn })
  : null;

function systemPrompt() {
  const file = process.env.CHATBOT_SYSTEM_PROMPT_FILE;
  if (file) return readFileSync(file, 'utf8').trim();
  return (
    process.env.CHATBOT_SYSTEM_PROMPT ??
    `You are ${PERSONA_NAME}, a persona on a Discord server, backed by the ${MODEL} model. ` +
      `You see the channel's recent history as a transcript and reply as yourself. ` +
      `Be conversational and concise by default; go long only when the question calls for it. ` +
      `Plain Discord markdown is fine.`
  );
}

// ── Main ──

async function main() {
  const creds = await loadOrEnrollCreds({
    url: URL_WS,
    credsPath: CREDS_PATH,
    invite: INVITE,
    desiredName: PERSONA_NAME,
  });
  log(`persona ${PERSONA_NAME} → ${creds.personaId}, model ${MODEL}` +
    (ROUTE.name
      ? ` via route ${ROUTE.name} (${ROUTE.baseUrl}, ${ROUTE.contextChars} chars` +
        (ROUTE.dailyUsd !== null ? `, cap $${ROUTE.dailyUsd}/day` : GATE ? ', metered' : ', unmetered') + ')'
      : ' via OpenRouter (no route)'));

  const client = new PortalClient({ url: URL_WS, token: creds.token, personaId: creds.personaId });

  const inFlight = new Set(); // de-dupe re-delivered events on resume
  const channelBusy = new Set(); // one completion at a time per channel
  const botChain = new Map(); // channelId → consecutive replies to non-human authors

  client.on('error', (e) => warn('client error', String(e?.message || e)));
  client.on('close', ({ code, willReconnect }) => log(`ws closed code=${code} reconnect=${willReconnect}`));
  client.on('resumed', (replayed) => log(`reconnected — session resumed (${replayed} events replayed)`));

  client.on('message', ({ message, addressedToMe, reasons }) => {
    if (message.author?.kind === 'persona' && message.author.personaId === creds.personaId) return;
    // A human speaking resets the bot⇄bot chain brake for the channel.
    if (isHuman(message)) botChain.delete(message.channelId);
    if (!addressedToMe) return;
    if (!reasons.includes('role_mention') && !reasons.includes('reply') && !reasons.includes('name_mention')) return;
    if (!isHuman(message) && (botChain.get(message.channelId) ?? 0) >= BOT_CHAIN_CAP) {
      log(`bot-chain cap reached in ${message.channelId}; staying quiet until a human speaks`);
      return;
    }
    if (inFlight.has(message.id) || channelBusy.has(message.channelId)) return;
    inFlight.add(message.id);
    channelBusy.add(message.channelId);
    handle(client, message)
      .then(({ outcome }) => {
        if (outcome === 'held-quiet') return; // nothing was posted
        botChain.set(message.channelId, isHuman(message) ? 0 : (botChain.get(message.channelId) ?? 0) + 1);
      })
      .catch((e) => warn('handler crash', String(e?.stack || e)))
      .finally(() => {
        inFlight.delete(message.id);
        channelBusy.delete(message.channelId);
      });
  });

  // A capped route answers one trigger at a time across all channels, so its
  // cap is overshot by at most one reply; an uncapped route runs channels in parallel.
  const queue = ROUTE.dailyUsd !== null ? serial() : (job) => job();

  function handle(client, trigger) {
    const channelId = trigger.threadId ?? trigger.channelId;
    return queue(async () => {
      const result = await answer({
        trigger,
        route: ROUTE,
        gate: GATE,
        spendDir: SPEND_DIR,
        system: systemPrompt(),
        personaName: PERSONA_NAME,
        log,
        fetchMessages: () =>
          fetchForWindow(
            (params) => client.fetchHistory(params),
            { channelId: trigger.channelId, threadId: trigger.threadId },
            ROUTE.contextChars,
            { maxMessages: HISTORY_MAX },
          ),
        complete: (messages) => complete(ROUTE, API_KEY, messages),
        send: (content) => client.sendMessage({ channelId, content, replyToId: trigger.id }),
        // Typing indicator while we think. Discord expires it after ~10 s, so pulse
        // until the reply is out. Best-effort — a typing failure must not eat the reply.
        startTyping: () => {
          const pulse = () => client.setTyping(trigger.channelId, trigger.threadId).catch(() => {});
          void pulse();
          const typing = setInterval(pulse, 8000);
          return () => clearInterval(typing);
        },
      });
      if (result.outcome === 'replied') {
        log(`replied in ${trigger.channelId} to ${authorName(trigger)} (${result.chars} chars)`);
      } else if (result.outcome === 'held-quiet') {
        log(`holding (${result.reason}); ${channelId} already noticed today, staying quiet`);
      }
      return result;
    });
  }

  await client.connect();
  log(`connected to ${URL_WS} — waiting for @mentions/replies`);

  process.on('SIGINT', () => { client.close(); process.exit(0); });
  process.on('SIGTERM', () => { client.close(); process.exit(0); });
}

main().catch((e) => {
  console.error('[chatbot] FATAL', e);
  process.exit(1);
});
