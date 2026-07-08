#!/usr/bin/env node
// portal-chatbot — a generic Portal chat persona backed by an OpenRouter model.
//
// @-mention the persona (or reply to it) and it answers, with the channel's
// recent history as context. It holds no Discord bot token and uses no
// integration slot: it self-enrolls a tokenless persona from a Portal invite
// and talks only to the relay over WebSocket (same pattern as portal-makeaudio).
//
// Long replies are handled by the relay's markdown-preserving split sends
// (RFC-006) — the bot just sends; parts and bridges are the relay's business.
//
// Environment:
//   OPENROUTER_API_KEY    Required.
//   OPENROUTER_MODEL      Model id (default deepseek/deepseek-v4-pro).
//   OPENROUTER_PROVIDER   Optional JSON provider-routing object, passed through
//                         verbatim (e.g. '{"order":["deepinfra"],"allow_fallbacks":false}').
//   PORTAL_URL            Relay WS url (default ws://127.0.0.1:8790).
//   PORTAL_INVITE         Invite code for first-run enrollment.
//   PORTAL_PERSONA_NAME   Desired persona name (default "DeepSeek").
//   PORTAL_CREDENTIALS    Creds cache path (default ~/.portal/chatbot.creds.json).
//   CHATBOT_SYSTEM_PROMPT       Inline system prompt, or
//   CHATBOT_SYSTEM_PROMPT_FILE  path to one (file wins; both optional).
//   CHATBOT_HISTORY       Context window in messages (default 40).
//   CHATBOT_MAX_TOKENS    Reply budget (default 1024).
//   CHATBOT_BOT_CHAIN_CAP Max consecutive replies to non-human authors per
//                         channel before going quiet until a human speaks
//                         (default 6; loop brake for bot⇄bot ping-pong).
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PortalClient, loadOrEnrollCreds } from '../../portal-client/dist/src/index.js';

const OR_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-v4-pro';
const PROVIDER = process.env.OPENROUTER_PROVIDER ? JSON.parse(process.env.OPENROUTER_PROVIDER) : undefined;
const URL_WS = process.env.PORTAL_URL ?? 'ws://127.0.0.1:8790';
const INVITE = process.env.PORTAL_INVITE;
const PERSONA_NAME = process.env.PORTAL_PERSONA_NAME ?? 'DeepSeek';
const CREDS_PATH = process.env.PORTAL_CREDENTIALS ?? join(homedir(), '.portal', 'chatbot.creds.json');
const HISTORY = Number(process.env.CHATBOT_HISTORY ?? '40');
const MAX_TOKENS = Number(process.env.CHATBOT_MAX_TOKENS ?? '1024');
const BOT_CHAIN_CAP = Number(process.env.CHATBOT_BOT_CHAIN_CAP ?? '6');

if (!OR_KEY) {
  console.error('[chatbot] OPENROUTER_API_KEY is required');
  process.exit(2);
}

const log = (...a) => console.log('[chatbot]', ...a);
const warn = (...a) => console.warn('[chatbot]', ...a);

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

// ── Transcript rendering ──

function authorName(m) {
  const a = m.author;
  if (a.kind === 'persona') return a.displayName;
  if (a.kind === 'user') return a.displayName || a.username;
  return 'system';
}

function isHuman(m) {
  return m.author.kind === 'user' && !m.author.bot;
}

/** Render history (oldest first) as a transcript, merging split-send parts
 *  (RFC-006 partOf chains) back into one logical message. */
function renderTranscript(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const lines = [];
  for (const m of messages) {
    if (m.partOf && byId.has(m.partOf)) continue; // folded into its first part below
    let text = m.cleanContent || m.content || '';
    for (const part of messages) {
      if (part.partOf === m.id) text += `\n${part.cleanContent || part.content || ''}`;
    }
    const notes = (m.attachments ?? []).map(
      (a) => `[attached: ${a.name} (${a.contentType ?? 'unknown'}, ${a.size}B)]`,
    );
    lines.push(`${authorName(m)}: ${[text, ...notes].filter(Boolean).join(' ')}`);
  }
  return lines.join('\n');
}

// ── OpenRouter ──

async function complete(transcript, trigger) {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OR_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      ...(PROVIDER ? { provider: PROVIDER } : {}),
      max_tokens: MAX_TOKENS,
      messages: [
        { role: 'system', content: systemPrompt() },
        {
          role: 'user',
          content:
            `Recent channel history (oldest first):\n\n${transcript}\n\n` +
            `You were just addressed by ${authorName(trigger)}. Reply to them as ${PERSONA_NAME} — ` +
            `output only the reply text, no name prefix.`,
        },
      ],
    }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  const reply = body.choices?.[0]?.message?.content?.trim();
  if (!reply) throw new Error('empty completion');
  return reply;
}

// ── Main ──

async function main() {
  const creds = await loadOrEnrollCreds({
    url: URL_WS,
    credsPath: CREDS_PATH,
    invite: INVITE,
    desiredName: PERSONA_NAME,
  });
  log(`persona ${PERSONA_NAME} → ${creds.personaId}, model ${MODEL}`);

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
      .then(() => {
        botChain.set(message.channelId, isHuman(message) ? 0 : (botChain.get(message.channelId) ?? 0) + 1);
      })
      .catch((e) => warn('handler crash', String(e?.stack || e)))
      .finally(() => {
        inFlight.delete(message.id);
        channelBusy.delete(message.channelId);
      });
  });

  async function handle(client, trigger) {
    const { messages } = await client.fetchHistory({
      channelId: trigger.channelId,
      threadId: trigger.threadId,
      limit: HISTORY,
    });
    messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const reply = await complete(renderTranscript(messages), trigger);
    await client.sendMessage({ channelId: trigger.threadId ?? trigger.channelId, content: reply, replyToId: trigger.id });
    log(`replied in ${trigger.channelId} to ${authorName(trigger)} (${reply.length} chars)`);
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
