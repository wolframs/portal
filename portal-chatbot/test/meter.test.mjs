import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendSpend, callDollars, normalizeUsage, spentToday } from '../src/meter.mjs';

// gemini-4-argon, USD per million tokens
const ARGON = { prompt: 2, completion: 10, cache_read: 0.1, cache_write: 0.1875 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-12, `${a} ≠ ${b}`);

test('plain OpenAI usage: input × prompt + output × completion', () => {
  const { dollars, estimated } = callDollars(ARGON, { prompt_tokens: 10000, completion_tokens: 500, total_tokens: 10500 }, { maxTokens: 2048, promptChars: 0 });
  assert.equal(estimated, false);
  close(dollars, 10000 * 2e-6 + 500 * 10e-6); // 0.025
});

test('OpenAI cached_tokens are inside prompt_tokens and priced at the read rate', () => {
  const usage = { prompt_tokens: 10000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 8000 } };
  assert.deepEqual(normalizeUsage(usage), { fresh: 2000, read: 8000, write: 0, output: 500 });
  close(callDollars(ARGON, usage, { maxTokens: 2048, promptChars: 0 }).dollars, 2000 * 2e-6 + 8000 * 0.1e-6 + 500 * 10e-6);
});

test('OpenRouter-style cache_write_tokens inside prompt_tokens are priced at the write rate', () => {
  const usage = { prompt_tokens: 10000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 9000 } };
  close(callDollars(ARGON, usage, { maxTokens: 2048, promptChars: 0 }).dollars, 1000 * 2e-6 + 9000 * 0.1875e-6);
});

test('Anthropic-style top-level cache fields are disjoint from input_tokens', () => {
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 2000 };
  assert.deepEqual(normalizeUsage(usage), { fresh: 100, read: 4000, write: 2000, output: 50 });
});

test('cache counts reported both nested and top-level are charged once, nested first', () => {
  const both = {
    prompt_tokens: 10000, completion_tokens: 0,
    prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 1000 },
    cache_read_input_tokens: 8000, cache_creation_input_tokens: 1000,
  };
  assert.deepEqual(normalizeUsage(both), { fresh: 1000, read: 8000, write: 1000, output: 0 });
  close(callDollars(ARGON, both, { maxTokens: 2048, promptChars: 0 }).dollars, 1000 * 2e-6 + 8000 * 0.1e-6 + 1000 * 0.1875e-6);
});

test('a nested cache count of zero gives way to a top-level one, taken as disjoint', () => {
  const usage = { prompt_tokens: 100, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 }, cache_read_input_tokens: 4000 };
  assert.deepEqual(normalizeUsage(usage), { fresh: 100, read: 4000, write: 0, output: 0 });
});

test('reasoning tokens are inside completion and not added twice', () => {
  const usage = { prompt_tokens: 0, completion_tokens: 1000, completion_tokens_details: { reasoning_tokens: 800 } };
  close(callDollars(ARGON, usage, { maxTokens: 2048, promptChars: 0 }).dollars, 1000 * 10e-6);
});

test('a missing cache price falls back to the prompt price, never to free', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 1000 } };
  close(callDollars({ prompt: 2, completion: 10 }, usage, { maxTokens: 1, promptChars: 0 }).dollars, 1000 * 2e-6);
});

test('an inclusive cache count larger than prompt_tokens does not go negative', () => {
  assert.equal(normalizeUsage({ prompt_tokens: 10, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 50 } }).fresh, 0);
});

test('absent usage is charged at max_tokens plus the prompt at chars/3', () => {
  for (const usage of [null, undefined, {}, { prompt_tokens: 5 }, { completion_tokens: 'x', prompt_tokens: 1 }]) {
    const r = callDollars(ARGON, usage, { maxTokens: 2048, promptChars: 30001 });
    assert.equal(r.estimated, true);
    close(r.dollars, 2048 * 10e-6 + 10001 * 2e-6);
  }
});

test('today\'s spend sums only this UTC day, across the midnight boundary', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-spend-'));
  appendSpend(dir, 'argon', { ts: '2026-10-18T23:59:59.900Z', route: 'argon', dollars: 0.2 });
  appendSpend(dir, 'argon', { ts: '2026-10-19T00:00:00.100Z', route: 'argon', dollars: 0.05 });
  appendSpend(dir, 'argon', { ts: '2026-10-19T00:10:00.000Z', route: 'argon', dollars: 0.01 });
  close(spentToday(dir, 'argon', new Date('2026-10-18T23:59:59.999Z')), 0.2);
  close(spentToday(dir, 'argon', new Date('2026-10-19T00:00:00.000Z')), 0.06);
  assert.equal(spentToday(dir, 'wonder', new Date()), 0); // no file yet
});

test('a torn line is skipped with a warning, not fatal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-spend-'));
  appendSpend(dir, 'flash', { ts: '2026-10-18T10:00:00Z', dollars: 0.1 });
  appendFileSync(join(dir, 'flash.jsonl'), '{"ts":"2026-10-18T1');
  const warned = [];
  close(spentToday(dir, 'flash', new Date('2026-10-18T12:00:00Z'), (w) => warned.push(w)), 0.1);
  assert.equal(warned.length, 1);
});

test('an entry appended after an unterminated last line is not swallowed by it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-spend-'));
  appendSpend(dir, 'flash', { ts: '2026-10-18T10:00:00Z', dollars: 0.1 });
  appendFileSync(join(dir, 'flash.jsonl'), '{"ts":"2026-10-18T1'); // a crash mid-write
  appendSpend(dir, 'flash', { ts: '2026-10-18T11:00:00Z', dollars: 0.05 }); // after the restart
  const warned = [];
  close(spentToday(dir, 'flash', new Date('2026-10-18T12:00:00Z'), (w) => warned.push(w)), 0.15);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /\{"ts":"2026-10-18T1$/);
  assert.equal(readFileSync(join(dir, 'flash.jsonl'), 'utf8').split('\n').length, 4); // three lines and the final newline
});

test('without a warn callback, a malformed spend line is reported on stderr', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-spend-'));
  appendFileSync(join(dir, 'flash.jsonl'), 'not json\n{"ts":"2026-10-18T10:00:00Z","dollars":0.1}\n');
  const written = [];
  const real = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => (written.push(String(chunk)), true);
  try {
    close(spentToday(dir, 'flash', new Date('2026-10-18T12:00:00Z')), 0.1);
  } finally {
    process.stderr.write = real;
  }
  assert.equal(written.length, 1);
  assert.match(written[0], /unreadable spend line.*not json/);
});
