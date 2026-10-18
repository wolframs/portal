import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchForWindow, renderLines, renderTranscript, windowByChars } from '../src/transcript.mjs';

let seq = 0;
const msg = (name, content, extra = {}) => {
  seq += 1;
  return {
    id: `m${seq}`,
    createdAt: new Date(Date.UTC(2026, 9, 18, 12, 0, seq)).toISOString(),
    author: { kind: 'user', displayName: name, username: name.toLowerCase() },
    content,
    ...extra,
  };
};

test('window keeps the newest whole lines that fit, counting newlines', () => {
  const lines = ['aaaa', 'bbbb', 'cccc']; // joined newest two = 'bbbb\ncccc' = 9 chars
  assert.deepEqual(windowByChars(lines, 9), ['bbbb', 'cccc']);
  assert.deepEqual(windowByChars(lines, 8), ['cccc']);
  assert.deepEqual(windowByChars(lines, 14), ['aaaa', 'bbbb', 'cccc']);
  assert.deepEqual(windowByChars(lines, 3), []); // never a cut message
});

test('window is a contiguous suffix: a long older line ends it even if shorter ones would fit', () => {
  assert.deepEqual(windowByChars(['a', 'x'.repeat(50), 'b'], 10), ['b']);
});

test('rendered transcript respects context_chars exactly', () => {
  const ms = Array.from({ length: 200 }, (_, i) => msg('Ann', `message number ${i} `.repeat(5)));
  const t = renderTranscript(ms, 2000);
  assert.ok(t.length <= 2000);
  assert.ok(t.endsWith(ms.at(-1).content.trimEnd()) || t.endsWith(ms.at(-1).content));
  // one more line would not have fitted
  const lines = renderLines(ms);
  const kept = t.split('\n').length;
  assert.ok(t.length + 1 + lines[lines.length - kept - 1].length > 2000);
});

test('split-send parts fold into their head; an orphan part is dropped', () => {
  const head = msg('Bot', 'part one');
  const tail = msg('Bot', 'part two', { partOf: head.id });
  const orphan = msg('Bot', 'tail of something older', { partOf: 'gone' });
  const after = msg('Ann', 'thanks');
  // relay pages arrive newest first
  const lines = renderLines([after, orphan, tail, head]);
  assert.deepEqual(lines, ['Bot: part one\npart two', 'Ann: thanks']);
});

test('attachments are described, not sent', () => {
  const m = msg('Ann', 'look', { attachments: [{ name: 'a.png', contentType: 'image/png', size: 10 }] });
  assert.deepEqual(renderLines([m]), ['Ann: look [attached: a.png (image/png, 10B)]']);
});

test('fetchForWindow pages back with `before` until the window can be filled', async () => {
  const all = Array.from({ length: 250 }, (_, i) => msg('Ann', 'x'.repeat(95))); // ~100 chars each
  const calls = [];
  const fake = async ({ limit, before }) => {
    calls.push({ limit, before });
    const end = before ? all.findIndex((m) => m.id === before) : all.length;
    return { messages: all.slice(Math.max(0, end - limit), end).reverse() };
  };
  const got = await fetchForWindow(fake, { channelId: 'c' }, 15000, { pageSize: 100 });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].before, all[150].id);
  assert.equal(got.length, 200);
  // stops when the channel runs out
  const short = await fetchForWindow(fake, { channelId: 'c' }, 1e9, { pageSize: 100 });
  assert.equal(short.length, 250);
  // and at the message ceiling
  const capped = await fetchForWindow(fake, { channelId: 'c' }, 1e9, { pageSize: 100, maxMessages: 120 });
  assert.equal(capped.length, 120);
});
