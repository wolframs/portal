import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BudgetGate, HOLD_NOTICE } from '../src/gate.mjs';
import { complete as httpComplete } from '../src/llm.mjs';
import { appendSpend } from '../src/meter.mjs';
import { resolveRoute } from '../src/routes.mjs';
import { answer, serial } from '../src/turn.mjs';

const ROUTE = resolveRoute('argon', {}, {
  model: 'gemini-4-argon',
  base_url: 'https://api.surplusintelligence.ai/min70/v1',
  key_env: 'SURPLUS_DISCORD_API_KEY',
  daily_usd: 0.3,
  usd_per_mtok: { prompt: 2, completion: 10, cache_read: 0.1, cache_write: 0.1875 },
  allowed_params: ['max_tokens'],
});

const clock = (iso) => {
  const c = { t: new Date(iso) };
  c.now = () => c.t;
  return c;
};

const trigger = (channelId, threadId) => ({
  id: `t-${channelId}`,
  channelId,
  threadId,
  createdAt: '2026-10-18T12:00:00.000Z',
  author: { kind: 'user', displayName: 'Ann', username: 'ann' },
  content: '@Argon hi',
});

/** A turn harness: fake history, fake model, a send log, real files. */
function harness({ dir = mkdtempSync(join(tmpdir(), 'chatbot-turn-')), c = clock('2026-10-18T12:00:00Z'), reply } = {}) {
  const sent = [];
  const calls = [];
  const gate = () => new BudgetGate({ dir, route: 'argon', dailyUsd: ROUTE.dailyUsd, now: c.now });
  const run = (t, over = {}) =>
    answer({
      trigger: t,
      route: ROUTE,
      gate: gate(), // a fresh gate per turn: nothing survives in memory, as after a restart
      spendDir: dir,
      now: c.now,
      system: 'sys',
      personaName: 'Argon',
      fetchMessages: async () => [t],
      send: async (content) => sent.push({ channel: t.threadId ?? t.channelId, content }),
      complete: async (messages) => {
        calls.push(messages);
        return reply?.(messages) ?? { ok: true, status: 200, reply: 'hello', usage: { prompt_tokens: 1000, completion_tokens: 100 }, requestId: 'req-1', responseId: 'gen-1' };
      },
      ...over,
    });
  const ledger = () => readFileSync(join(dir, 'argon.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  return { dir, c, sent, calls, run, ledger, gate };
}

test('a reply is metered: one ledger line with usage, dollars and request id', async () => {
  const h = harness();
  assert.deepEqual(await h.run(trigger('c1')), { outcome: 'replied', chars: 5 });
  assert.deepEqual(h.sent, [{ channel: 'c1', content: 'hello' }]);
  const [e] = h.ledger();
  assert.equal(e.ts, '2026-10-18T12:00:00.000Z');
  assert.equal(e.route, 'argon');
  assert.equal(e.model, 'gemini-4-argon');
  assert.equal(e.request_id, 'req-1');
  assert.deepEqual(e.usage, { prompt_tokens: 1000, completion_tokens: 100 });
  assert.equal(e.usage_reported, true);
  assert.ok(Math.abs(e.dollars - (1000 * 2e-6 + 100 * 10e-6)) < 1e-12);
});

test('a reply without usage is recorded as such and charged the estimate', async () => {
  const h = harness({ reply: () => ({ ok: true, status: 200, reply: 'hi', usage: null }) });
  await h.run(trigger('c1'));
  const [e] = h.ledger();
  assert.equal(e.usage_reported, false);
  assert.equal(e.estimated, true);
  assert.ok(Math.abs(e.dollars - (2048 * 10e-6 + Math.ceil(e.prompt_chars / 3) * 2e-6)) < 1e-12);
});

test('at the cap: one notice per channel per UTC day, then silence; reset at 00:00 UTC', async () => {
  const h = harness({ c: clock('2026-10-18T23:00:00Z') });
  appendSpend(h.dir, 'argon', { ts: '2026-10-18T22:00:00Z', dollars: 0.3 }); // exactly at the cap

  assert.equal((await h.run(trigger('c1'))).outcome, 'held');
  assert.equal((await h.run(trigger('c1'))).outcome, 'held-quiet');
  assert.equal((await h.run(trigger('c2'))).outcome, 'held'); // a new channel hears it once too
  assert.equal((await h.run(trigger('c2', 'th1'))).outcome, 'held'); // a thread is its own channel
  assert.equal(h.calls.length, 0, 'no model call while held');
  assert.deepEqual(h.sent.map((s) => [s.channel, s.content]), [
    ['c1', HOLD_NOTICE], ['c2', HOLD_NOTICE], ['th1', HOLD_NOTICE],
  ]);

  h.c.t = new Date('2026-10-19T00:00:00.000Z');
  assert.equal((await h.run(trigger('c1'))).outcome, 'replied');
  assert.equal(h.calls.length, 1);
});

test('under the cap it answers; the reply that crosses it is the last', async () => {
  const h = harness({ reply: () => ({ ok: true, status: 200, reply: 'x', usage: { prompt_tokens: 0, completion_tokens: 20000 } }) }); // $0.20 each
  assert.equal((await h.run(trigger('c1'))).outcome, 'replied'); // 0.20
  assert.equal((await h.run(trigger('c1'))).outcome, 'replied'); // 0.40 — overshoot by one reply
  assert.equal((await h.run(trigger('c1'))).outcome, 'held');
  assert.equal(h.calls.length, 2);
});

test('the once-per-channel memory survives a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-turn-'));
  appendSpend(dir, 'argon', { ts: '2026-10-18T01:00:00Z', dollars: 1 });
  const first = harness({ dir });
  await first.run(trigger('c1'));
  const second = harness({ dir }); // new process: new gate, new send log
  assert.equal((await second.run(trigger('c1'))).outcome, 'held-quiet');
  assert.deepEqual(second.sent, []);
});

test('a failed notice is not remembered, so the next trigger tries again', async () => {
  const h = harness();
  appendSpend(h.dir, 'argon', { ts: '2026-10-18T01:00:00Z', dollars: 1 });
  await assert.rejects(h.run(trigger('c1'), { send: async () => { throw new Error('relay down'); } }), /relay down/);
  assert.equal((await h.run(trigger('c1'))).outcome, 'held');
});

test('402 from Surplus: no retry, notice once, hold for the day across restarts', async () => {
  const h = harness({
    reply: () => ({ ok: false, status: 402, reply: null, usage: null, requestId: 'req-402', errorText: '{"error":{"code":"budget_exceeded"}}' }),
  });
  const r = await h.run(trigger('c1'));
  assert.equal(r.outcome, 'held');
  assert.match(r.reason, /402.*budget_exceeded/);
  assert.equal(h.calls.length, 1, 'exactly one call, no retry');
  assert.deepEqual(h.sent, [{ channel: 'c1', content: HOLD_NOTICE }]);
  const [e] = h.ledger();
  assert.equal(e.status, 402);
  assert.equal(e.dollars, 0);
  assert.equal(e.request_id, 'req-402');

  assert.equal((await h.run(trigger('c1'))).outcome, 'held-quiet');
  assert.equal((await h.run(trigger('c3'))).outcome, 'held');
  assert.equal(h.calls.length, 1, 'held after 402 without spending under the cap');

  h.c.t = new Date('2026-10-19T00:00:01Z');
  await h.run(trigger('c1'));
  assert.equal(h.calls.length, 2, 'the hold lifts at the UTC reset');
});

test('a call that never got a response is charged the estimate and rethrown', async () => {
  const h = harness();
  await assert.rejects(h.run(trigger('c1'), { complete: async () => { throw new Error('ECONNRESET'); } }), /ECONNRESET/);
  const [e] = h.ledger();
  assert.equal(e.estimated, true);
  assert.ok(e.dollars > 0.02);
  assert.match(e.error, /ECONNRESET/);
});

test('other HTTP errors are logged at zero, thrown, and do not hold', async () => {
  const h = harness({ reply: () => ({ ok: false, status: 503, reply: null, usage: null, errorText: 'no seller' }) });
  await assert.rejects(h.run(trigger('c1')), /503: no seller/);
  assert.equal(h.ledger()[0].dollars, 0);
  assert.equal(h.gate().holdReason(), null);
});

test('the window bounds what is sent: context_chars of history plus the system prompt', async () => {
  const h = harness();
  const small = { ...ROUTE, contextChars: 40 };
  const history = Array.from({ length: 10 }, (_, i) => ({ ...trigger('c1'), id: `h${i}`, createdAt: `2026-10-18T11:00:0${i}.000Z`, content: `line ${i}` }));
  await h.run(trigger('c1'), { route: small, fetchMessages: async () => history });
  const user = h.calls[0][1].content;
  assert.match(user, /Ann: line 9/);
  assert.match(user, /Ann: line 7/);
  assert.doesNotMatch(user, /line 6/); // 'Ann: line 7\nAnn: line 8\nAnn: line 9' = 35 chars; one more is 47
  assert.equal(h.calls[0][0].content, 'sys');
});

test('an unmetered route (no gate) never writes a ledger', async () => {
  const h = harness();
  await h.run(trigger('c1'), { gate: null });
  assert.throws(() => h.ledger(), /ENOENT/);
});

test('llm.complete posts to the route URL, sends only allowed fields, and reads usage and request id', async () => {
  let seen;
  const fakeFetch = async (url, init) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      headers: new Map([['x-request-id', 'req-h']]),
      text: async () => JSON.stringify({ id: 'gen-9', choices: [{ message: { content: ' hey ' } }], usage: { prompt_tokens: 3, completion_tokens: 1 } }),
    };
  };
  const r = await httpComplete(ROUTE, 'sk-test', [{ role: 'user', content: 'hi' }], fakeFetch);
  assert.equal(seen.url, 'https://api.surplusintelligence.ai/min70/v1/chat/completions');
  assert.equal(seen.init.headers.Authorization, 'Bearer sk-test');
  assert.deepEqual(Object.keys(JSON.parse(seen.init.body)).sort(), ['max_tokens', 'messages', 'model']);
  assert.deepEqual(r, { ok: true, status: 200, reply: 'hey', usage: { prompt_tokens: 3, completion_tokens: 1 }, requestId: 'req-h', responseId: 'gen-9', errorText: null });

  const r402 = await httpComplete(ROUTE, 'k', [], async () => ({
    ok: false, status: 402, headers: new Map(), text: async () => '{"error":{"code":"budget_exceeded"},"request_id":"req-b"}',
  }));
  assert.equal(r402.status, 402);
  assert.equal(r402.requestId, 'req-b');
  assert.match(r402.errorText, /budget_exceeded/);
});

test('serial() runs jobs one at a time and survives a failing job', async () => {
  const q = serial();
  const order = [];
  let active = 0;
  const job = (name, fail) => async () => {
    active += 1;
    assert.equal(active, 1);
    await new Promise((r) => setTimeout(r, 5));
    order.push(name);
    active -= 1;
    if (fail) throw new Error(name);
  };
  const results = await Promise.allSettled([q(job('a')), q(job('b', true)), q(job('c'))]);
  assert.deepEqual(order, ['a', 'b', 'c']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
});
