import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildAttachments } from '../src/discord-bot.js';

const LIMITS = { maxTotalBytes: 8 * 1024 * 1024, allowPath: false };
const b64 = (s: string) => Buffer.from(s).toString('base64');

test('inline bytes → attachment with the given name + buffer', () => {
  const [a] = buildAttachments([{ name: 'hi.txt', bytes: b64('hello') }], LIMITS);
  assert.equal(a.name, 'hi.txt');
  assert.ok(Buffer.isBuffer(a.attachment), 'attachment is a Buffer');
  assert.equal((a.attachment as Buffer).toString(), 'hello');
});

test('bytes without a name is rejected (INVALID_PARAMS)', () => {
  assert.throws(() => buildAttachments([{ bytes: b64('x') }], LIMITS), (e: Error & { code?: string }) => e.code === 'INVALID_PARAMS');
});

test('both bytes and path is rejected', () => {
  assert.throws(() => buildAttachments([{ name: 'a', bytes: b64('x'), path: '/tmp/a' }], LIMITS), /exactly one/);
});

test('neither bytes nor path is rejected', () => {
  assert.throws(() => buildAttachments([{ name: 'a' }], LIMITS), /exactly one/);
});

test('path files rejected when allowPath is false', () => {
  assert.throws(
    () => buildAttachments([{ path: '/etc/passwd' }], { maxTotalBytes: 1e9, allowPath: false }),
    /disabled/,
  );
});

test('per-message total budget enforced across files', () => {
  // maxTotalBytes=6: first file (2B) ok, second (6B) pushes total to 8 → reject
  assert.throws(
    () =>
      buildAttachments(
        [
          { name: 'a', bytes: b64('hi') },
          { name: 'b', bytes: b64('world!') },
        ],
        { maxTotalBytes: 6, allowPath: false },
      ),
    /exceed 6 bytes/,
  );
});

test('more than 10 files rejected', () => {
  const files = Array.from({ length: 11 }, (_, i) => ({ name: `f${i}`, bytes: b64('x') }));
  assert.throws(() => buildAttachments(files, LIMITS), /max 10/);
});
