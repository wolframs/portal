import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TypedEmitter } from '../src/emitter.js';
import { PortalClient } from '../src/client.js';

test('emit isolates a throwing listener — others still run, caller unaffected', () => {
  const em = new TypedEmitter<{ x: () => void }>();
  let secondRan = false;
  em.on('x', () => {
    throw new Error('boom');
  });
  em.on('x', () => {
    secondRan = true;
  });
  assert.doesNotThrow(() => em.emit('x')); // must not propagate to caller
  assert.equal(secondRan, true); // subsequent listener still ran
});

/** Minimal ws stand-in: EventEmitter with the surface PortalClient touches. */
class FakeWs extends EventEmitter {
  readyState = 1;
  readonly OPEN = 1;
  sent: string[] = [];
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
    this.emit('close', 1000);
  }
}

test('reconnect survives a throwing close listener and opens a new connection', async () => {
  const created: FakeWs[] = [];
  const client = new PortalClient({
    url: 'ws://test',
    token: 't',
    personaId: 'p',
    maxBackoffMs: 20, // keep the (jittered) delay tiny for the test
    wsFactory: () => {
      const w = new FakeWs();
      created.push(w);
      return w as unknown as import('ws').WebSocket;
    },
  });

  // A misbehaving close listener must NOT stall the reconnect loop.
  client.on('close', () => {
    throw new Error('boom');
  });

  client.connect().catch(() => {}); // opens ws #1; never resolves (no 'ready' frame)
  assert.equal(created.length, 1);

  created[0].emit('close', 1006); // simulate an unexpected drop
  await new Promise((r) => setTimeout(r, 60)); // > jittered backoff (≤20ms)

  assert.ok(created.length >= 2, 'a new connection was opened despite the throwing listener');
  client.close(); // stop further reconnects
});
