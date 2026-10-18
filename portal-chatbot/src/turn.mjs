// One reply, from trigger to sent message, with the cap checked first and the
// call metered after. Transport-free: the Portal client, the HTTP call and the
// clock are passed in, so the whole turn runs under test with fakes.
import { HOLD_NOTICE } from './gate.mjs';
import { appendSpend, callDollars, normalizeUsage } from './meter.mjs';
import { authorName, renderTranscript } from './transcript.mjs';

export function chatMessages({ system, transcript, trigger, personaName }) {
  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content:
        `Recent channel history (oldest first):\n\n${transcript}\n\n` +
        `You were just addressed by ${authorName(trigger)}. Reply to them as ${personaName} — ` +
        `output only the reply text, no name prefix.`,
    },
  ];
}

const promptChars = (messages) => messages.reduce((n, m) => n + m.content.length, 0);

/**
 * @param {object} o
 * @param {object} o.trigger        the PortalMessage that addressed the persona
 * @param {object} o.route          resolved route (routes.mjs)
 * @param {object|null} o.gate      BudgetGate, or null for an unmetered route
 * @param {string|null} o.spendDir  where <route>.jsonl lives (metered routes)
 * @param {() => Promise<object[]>} o.fetchMessages  history for the trigger's channel
 * @param {(content: string) => Promise<unknown>} o.send  reply in the trigger's channel
 * @param {(messages: object[]) => Promise<object>} o.complete  llm.complete bound to route+key
 * @param {() => () => void} [o.startTyping]  starts a typing pulse, returns its stop
 * @returns {Promise<{ outcome: 'replied'|'held'|'held-quiet', reason?: string, chars?: number }>}
 */
export async function answer(o) {
  const { trigger, route, gate, spendDir, now = () => new Date(), log = () => {} } = o;
  const channel = trigger.threadId ?? trigger.channelId;

  const holdNotice = async (reason) => {
    const day = gate.today(); // the notice's own day, carried through a slow send
    if (!gate.needsNotice(channel, day)) return { outcome: 'held-quiet', reason };
    await o.send(HOLD_NOTICE);
    gate.markNoticed(channel, day); // only once the notice is actually out
    log(`holding (${reason}); noticed ${channel}`);
    return { outcome: 'held', reason };
  };

  if (gate) {
    const reason = gate.holdReason();
    if (reason) return holdNotice(reason);
  }

  const stopTyping = o.startTyping?.() ?? (() => {});
  try {
    const history = await o.fetchMessages();
    const messages = chatMessages({
      system: o.system,
      transcript: renderTranscript(history, route.contextChars),
      trigger,
      personaName: o.personaName,
    });

    // Only a metered route (one with a gate) is priced; the no-route
    // OpenRouter path has no prices and writes no ledger.
    const meter = (fields) => {
      appendSpend(spendDir, route.name, {
        ts: now().toISOString(),
        route: route.name,
        model: route.model,
        prompt_chars: promptChars(messages),
        ...fields,
      });
    };
    const estimate = (usage) =>
      callDollars(route.price, usage, { maxTokens: route.maxTokens, promptChars: promptChars(messages) });

    let res;
    try {
      res = await o.complete(messages);
    } catch (e) {
      // No response at all: the request may still have been served and billed.
      if (gate) {
        const { dollars } = estimate(null);
        meter({ status: null, error: String(e?.message || e), usage: null, usage_reported: false, estimated: true, dollars });
      }
      throw e;
    }

    if (gate) {
      const ids = { status: res.status, request_id: res.requestId ?? null, response_id: res.responseId ?? null };
      if (res.status >= 400 && res.status < 500) {
        // A refusal the endpoint answered (402 or another 4xx) is not billed.
        meter({ ...ids, usage: res.usage ?? null, usage_reported: normalizeUsage(res.usage) !== null, tokens: null, estimated: false, dollars: 0, error: res.errorText });
      } else {
        // A reply, a 5xx or any other answer may have been served: its reported
        // usage is priced, and without usable usage it is charged the estimate.
        const { dollars, estimated, tokens } = estimate(res.usage);
        meter({
          ...ids, usage: res.usage ?? null, usage_reported: !estimated, tokens, estimated, dollars,
          ...(res.ok ? {} : { error: res.errorText }),
        });
      }
    }

    if (res.status === 402 && gate) {
      // Budget refusal at Surplus: hard stop for the day — no retry, no fallback.
      const reason = `marketplace 402: ${res.errorText ?? 'payment required'}`;
      gate.hold(reason);
      stopTyping();
      return holdNotice(reason);
    }
    if (!res.ok) throw new Error(`${route.baseUrl} ${res.status}: ${res.errorText}`);
    if (!res.reply) throw new Error('empty completion');

    await o.send(res.reply);
    return { outcome: 'replied', chars: res.reply.length };
  } finally {
    stopTyping();
  }
}

/** Run async jobs one at a time, in arrival order. A capped route answers
 *  serially, so its cap can be overshot by at most one reply. */
export function serial() {
  let tail = Promise.resolve();
  return (job) => {
    const run = tail.then(job, job);
    tail = run.catch(() => {});
    return run;
  };
}
