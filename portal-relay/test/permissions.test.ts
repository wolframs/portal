import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PermissionsStore } from '../src/permissions.js';
import type { PermissionsFile } from '../src/config.js';

function tmpFile(contents: PermissionsFile): string {
  const dir = mkdtempSync(join(tmpdir(), 'portal-perms-'));
  const path = join(dir, 'permissions.json');
  writeFileSync(path, JSON.stringify(contents));
  return path;
}

const RW = ['VIEW_CHANNEL', 'READ_HISTORY', 'SEND_MESSAGES'] as const;
const sorted = (s: Set<string>) => [...s].sort();

test('legacy inline PersonaPolicy still resolves (backward compat)', () => {
  // No `roles`/`policy` wrapper — the old on-disk shape.
  const path = tmpFile({
    personas: {
      lena: { default: ['VIEW_CHANNEL'], guilds: { g1: { channels: { c1: [...RW] } } } },
    },
  });
  const store = new PermissionsStore(path);
  assert.deepEqual(sorted(store.resolve('lena', 'g1', 'c1')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('lena', 'g1', 'other')), ['VIEW_CHANNEL']); // guild has no default → persona default
  assert.deepEqual(sorted(store.resolve('unknown', 'g1', 'c1')), []); // file default deny
  rmSync(path, { force: true });
});

test('scoped grant (channels) is default-deny outside scope', () => {
  // Shape an enrollment would stamp for grant{ scope:{channels:[pub]} }.
  const path = tmpFile({
    personas: {
      guest: { policy: { default: [], guilds: { g1: { default: [], channels: { pub: [...RW] } } } } },
    },
  });
  const store = new PermissionsStore(path);
  assert.deepEqual(sorted(store.resolve('guest', 'g1', 'pub')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('guest', 'g1', 'private')), []); // outside scope → deny
  assert.deepEqual(sorted(store.resolve('guest', 'g1', 'anything')), []);
  rmSync(path, { force: true });
});

test('access roles: channels scope + union (most-permissive) across roles', () => {
  const path = tmpFile({
    roles: {
      reader: { caps: ['VIEW_CHANNEL', 'READ_HISTORY'], scope: { channels: ['c1', 'c2'] } },
      poster: { caps: ['SEND_MESSAGES'], scope: { channels: ['c2'] } },
    },
    personas: { bot: { roles: ['reader', 'poster'] } },
  });
  const store = new PermissionsStore(path);
  // c1: only reader applies
  assert.deepEqual(sorted(store.resolve('bot', 'g1', 'c1')), ['READ_HISTORY', 'VIEW_CHANNEL']);
  // c2: union of both
  assert.deepEqual(sorted(store.resolve('bot', 'g1', 'c2')), ['READ_HISTORY', 'SEND_MESSAGES', 'VIEW_CHANNEL']);
  // c3: neither → deny
  assert.deepEqual(sorted(store.resolve('bot', 'g1', 'c3')), []);
  rmSync(path, { force: true });
});

test('scope:{all} grants everywhere; unknown role name is ignored', () => {
  const path = tmpFile({
    roles: { admin: { caps: [...RW], scope: { all: true } } },
    personas: { a: { roles: ['admin', 'ghost'] } },
  });
  const store = new PermissionsStore(path);
  assert.deepEqual(sorted(store.resolve('a', 'g1', 'anywhere')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('a', null, 'dm')), [...RW].sort());
  rmSync(path, { force: true });
});

test('mirrorRole scope: fail-closed without lookup, then gated by visibility', () => {
  const path = tmpFile({
    roles: { staff: { caps: [...RW], scope: { mirrorRole: 'role-staff' }, guildId: 'g1' } },
    personas: { s: { roles: ['staff'] } },
  });
  const store = new PermissionsStore(path);

  // No mirror lookup injected yet → deny everything (fail-closed).
  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c1')), []);

  // Inject a fake visibility: role-staff sees c1, c2 (but not c3).
  const visible = new Map([['g1:role-staff', new Set(['c1', 'c2'])]]);
  store.setMirrorVisibility((g, r) => visible.get(`${g}:${r}`) ?? new Set());

  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c1')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c2')), [...RW].sort());
  assert.deepEqual(sorted(store.resolve('s', 'g1', 'c3')), []); // not visible → deny
  // Cross-guild: mirror is per-guild → deny.
  assert.deepEqual(sorted(store.resolve('s', 'g2', 'c1')), []);
  rmSync(path, { force: true });
});

test('setPersonaPolicy / setPersonaRoles persist and round-trip', () => {
  const path = tmpFile({ roles: { r: { caps: ['VIEW_CHANNEL'], scope: { all: true } } }, personas: {} });
  const store = new PermissionsStore(path);

  store.setPersonaPolicy('p1', { default: [], guilds: { g1: { default: [], channels: { c1: [...RW] } } } });
  store.setPersonaRoles('p2', ['r']);

  // Reload from disk into a fresh store and re-resolve.
  const reloaded = new PermissionsStore(path);
  assert.deepEqual(sorted(reloaded.resolve('p1', 'g1', 'c1')), [...RW].sort());
  assert.deepEqual(sorted(reloaded.resolve('p1', 'g1', 'c2')), []);
  assert.deepEqual(sorted(reloaded.resolve('p2', 'g1', 'anywhere')), ['VIEW_CHANNEL']);

  // policy-only persona persists in legacy inline shape (no `policy` wrapper).
  const onDisk = JSON.parse(readFileSync(path, 'utf8')) as PermissionsFile;
  assert.ok('default' in (onDisk.personas.p1 as Record<string, unknown>));
  assert.deepEqual((onDisk.personas.p2 as { roles: string[] }).roles, ['r']);
  rmSync(path, { force: true });
});
