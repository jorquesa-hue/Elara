// Tranche 9 — portal over HTTP: the SPA is served at the root and the API
// round-trips over real node:http, including auth and permission gating. 3 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';

import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator } from '../src/api/context.ts';
import { createHttpServer } from '../src/api/http.ts';

async function withServer(fn: (base: string) => Promise<void>) {
  const auth = new StaticTokenAuthenticator({
    'tok-owner': { actor: 'o', tenantId: 't-1', role: 'owner' },
    'tok-ro': { actor: 'r', tenantId: 't-1', role: 'read_only' },
  });
  const app = new App({ authenticator: auth, units: [{ id: 'u-1', tenantId: 't-1' }], now: () => '2026-07-01T00:00:00Z' });
  const server = createHttpServer(app);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

const hdr = (tok: string) => ({ authorization: `Bearer ${tok}`, 'content-type': 'application/json' });

test('portal SPA is served at the root', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    const html = await res.text();
    assert.match(html, /Unified Stay OS/);
    assert.match(html, /setup\.title|renderSetup/); // the wizard code is present
  });
});

test('API round-trips over HTTP with auth', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/me`)).status, 401); // no token
    const me = await fetch(`${base}/me`, { headers: hdr('tok-owner') });
    assert.equal(me.status, 200);
    assert.equal((await me.json()).role, 'owner');

    const put = await fetch(`${base}/config`, { method: 'PUT', headers: hdr('tok-owner'), body: JSON.stringify({ displayName: 'Rio', currency: 'BRL', locale: 'pt-BR' }) });
    assert.equal(put.status, 200);
    assert.equal((await put.json()).currency, 'BRL');
  });
});

test('permission gating enforced over HTTP', async () => {
  await withServer(async (base) => {
    // read_only may read config but not change it.
    assert.equal((await fetch(`${base}/config`, { headers: hdr('tok-ro') })).status, 200);
    const denied = await fetch(`${base}/config`, { method: 'PUT', headers: hdr('tok-ro'), body: JSON.stringify({ currency: 'EUR' }) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).permission, 'config.manage');
  });
});
