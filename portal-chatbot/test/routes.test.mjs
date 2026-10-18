import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildBody } from '../src/llm.mjs';
import { legacyRoute, loadRoute, parseEnvFile, resolveKey, resolveRoute } from '../src/routes.mjs';

const EXAMPLE = fileURLToPath(new URL('../routes.example.json', import.meta.url));

const tmpTable = (table) => {
  const dir = mkdtempSync(join(tmpdir(), 'chatbot-routes-'));
  const file = join(dir, 'routes.json');
  writeFileSync(file, JSON.stringify(table));
  return file;
};

const BASE = {
  model: 'm',
  base_url: 'https://x.example/v1',
  key_env: 'K',
  usd_per_mtok: { prompt: 1, completion: 2 },
};

test('the committed example loads every route with the brief\'s defaults', () => {
  const want = {
    argon: ['gemini-4-argon', 'https://api.surplusintelligence.ai/min70/v1', 0.3],
    wonder: ['muse-wonder', 'https://api.surplusintelligence.ai/min70/v1', 0.3],
    mimo: ['mimo-v2.6-pro', 'https://api.surplusintelligence.ai/v1', 0.15],
    flash: ['gemini-3.8-flash', 'https://api.surplusintelligence.ai/v1', 0.25],
  };
  for (const [name, [model, base, cap]] of Object.entries(want)) {
    const r = loadRoute(EXAMPLE, name);
    assert.equal(r.model, model);
    assert.equal(r.baseUrl, base);
    assert.equal(r.dailyUsd, cap);
    assert.equal(r.contextChars, 75000);
    assert.equal(r.maxTokens, 2048);
    assert.equal(r.keyEnv, 'SURPLUS_DISCORD_API_KEY');
    assert.deepEqual(r.extra, {});
    assert.ok(r.price.prompt > 0 && r.price.completion > 0);
  }
  assert.ok(!loadRoute(EXAMPLE, 'wonder').allowedParams.includes('stop'));
  assert.ok(!loadRoute(EXAMPLE, 'mimo').allowedParams.includes('reasoning_effort'));
});

test('example prices match the catalogue (USD/token × 1e6)', () => {
  const r = loadRoute(EXAMPLE, 'argon');
  assert.deepEqual(r.price, { prompt: 2.0, completion: 10.0, cache_read: 0.1, cache_write: 0.1875 });
});

test('an unknown route names the routes the file does have', () => {
  assert.throws(() => loadRoute(EXAMPLE, 'nope'), /no route "nope" \(has: argon, wonder, mimo, flash\)/);
});

test('route fields override defaults; extra and params merge one level', () => {
  const file = tmpTable({
    defaults: { ...BASE, extra: { si_route: { objective: 'price' } }, allowed_params: ['max_tokens', 'temperature', 'top_p'], params: { temperature: 0.7 } },
    routes: { a: { model: 'other', extra: { providers_blocked: ['x'] }, params: { top_p: 0.9 }, max_tokens: 512 } },
  });
  const r = loadRoute(file, 'a');
  assert.equal(r.model, 'other');
  assert.equal(r.maxTokens, 512);
  assert.deepEqual(r.extra, { si_route: { objective: 'price' }, providers_blocked: ['x'] });
  assert.deepEqual(r.params, { temperature: 0.7, top_p: 0.9 });
});

test('loader rejects typos and unsafe settings instead of starting half-configured', () => {
  const bad = (own, re) => assert.throws(() => resolveRoute('r', {}, { ...BASE, ...own }), re);
  bad({ modle: 'x' }, /unknown field "modle"/);
  bad({ extra: { provider_ordr: [] } }, /extra field "provider_ordr"/);
  bad({ allowed_params: ['max_tokens', 'tools'] }, /may not include tools/);
  bad({ allowed_params: ['max_tokens'], params: { stop: ['\n'] } }, /params stop are not in allowed_params/);
  bad({ daily_usd: 1, usd_per_mtok: undefined }, /needs "usd_per_mtok"/);
  bad({ usd_per_mtok: { prompt: 1 } }, /needs at least "prompt" and "completion"/);
  bad({ usd_per_mtok: { prompt: 1, completion: 1, cached: 1 } }, /usd_per_mtok field "cached"/);
  bad({ context_chars: 0 }, /context_chars/);
  bad({ base_url: 'api.example' }, /base_url/);
  bad({ allowed_params: ['max_tokens'], params: { max_tokens: 10 } }, /not in params|allowed_params/);
});

test('only allowlisted parameters reach the body; extras go in at top level', () => {
  const r = resolveRoute('w', {}, {
    ...BASE,
    extra: { provider: 'acme', si_route: { objective: 'price' } },
    allowed_params: ['max_tokens', 'temperature'],
    params: { temperature: 0.5 },
    max_tokens: 300,
  });
  r.params.stop = ['x']; // smuggled past the loader: still not sent
  const body = buildBody(r, [{ role: 'user', content: 'hi' }]);
  assert.deepEqual(body, {
    provider: 'acme',
    si_route: { objective: 'price' },
    temperature: 0.5,
    max_tokens: 300,
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.ok(!('tools' in body) && !('stop' in body));
});

test('max_tokens is omitted when the model does not list it', () => {
  const r = resolveRoute('w', {}, { ...BASE, allowed_params: ['temperature'] });
  assert.ok(!('max_tokens' in buildBody(r, [])));
});

test('no route: the OpenRouter path from env, unmetered, provider passed verbatim', () => {
  const r = legacyRoute({ OPENROUTER_MODEL: 'deepseek/x', OPENROUTER_PROVIDER: '{"order":["deepinfra"]}' });
  assert.equal(r.baseUrl, 'https://openrouter.ai/api/v1');
  assert.equal(r.keyEnv, 'OPENROUTER_API_KEY');
  assert.equal(r.maxTokens, 1024);
  assert.equal(r.contextChars, 75000);
  assert.equal(r.price, null);
  assert.equal(r.dailyUsd, null);
  assert.deepEqual(buildBody(r, []), { provider: { order: ['deepinfra'] }, max_tokens: 1024, model: 'deepseek/x', messages: [] });
});

test('the key: env wins, then the route\'s dotenv key_file, else a clear error', () => {
  const r = { keyEnv: 'SURPLUS_DISCORD_API_KEY', keyFile: '/k.env' };
  const file = () => 'export OTHER=1\n# c\nSURPLUS_DISCORD_API_KEY="sk-file"\n';
  assert.equal(resolveKey(r, { SURPLUS_DISCORD_API_KEY: 'sk-env' }, file), 'sk-env');
  assert.equal(resolveKey(r, {}, file), 'sk-file');
  assert.throws(() => resolveKey(r, {}, () => 'OTHER=1'), /does not define it/);
  assert.throws(() => resolveKey({ keyEnv: 'K', keyFile: null }, {}), /K is required/);
  assert.deepEqual(parseEnvFile("A=1\nexport B = 'two'\nnot a line\n"), { A: '1', B: 'two' });
});
