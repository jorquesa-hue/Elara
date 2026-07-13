// Thin node:http binding for the Public API. No third-party deps — the router
// (App.dispatch) is the real surface; this only marshals HTTP <-> ApiRequest.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { App } from './app.ts';
import { portalHtml } from './portal.ts';
import { residentHtml } from './resident.ts';
import { bookingSiteHtml } from './booking-site.ts';

// Reject oversized bodies before buffering them fully — an unbounded POST is a
// trivial memory-exhaustion DoS. 1 MiB is generous for this JSON API (the
// largest legitimate payload is a CSV onboarding preview, still well under it).
const MAX_BODY_BYTES = 1 << 20;

class PayloadTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      // Stop consuming, but do NOT destroy the socket here — the caller still
      // has to WRITE the 413 (destroying first made clients see ECONNRESET
      // instead of the documented response). req.pause() halts the flood; the
      // response path closes the connection after the 413 is flushed.
      req.pause();
      throw new PayloadTooLargeError('request body exceeds 1 MiB limit');
    }
    chunks.push(buf);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('invalid JSON body');
  }
}

/** Hooks the server lifecycle (StayServer) uses to react to traffic. */
export interface HttpHooks {
  /** Called after each API response with the request's bearer + outcome, so the
   *  lifecycle can flush a tenant's writes durably (debounced). */
  onResponse?(info: { method: string; path: string; status: number; bearer?: string }): void;
}

export function createHttpServer(app: App, hooks: HttpHooks = {}): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      const qIdx = rawUrl.indexOf('?');
      const path = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);
      // Serve the operator portal SPA at the root; everything else is the API.
      if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/portal')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(portalHtml());
        return;
      }
      // The resident self-service SPA at /resident (party-scoped once signed in).
      if (req.method === 'GET' && (path === '/resident' || path === '/resident/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(residentHtml());
        return;
      }
      // Browsers auto-request /favicon.ico; answer 204 so it never hits the auth
      // gate (a harmless but noisy 401) on the portal or the public booking site.
      if (req.method === 'GET' && path === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      // The public guest-facing booking microsite at /site/<tenant> (exactly two
      // segments — deeper paths like /site/<tenant>/availability are JSON API).
      if (req.method === 'GET' && /^\/site\/[^/]+\/?$/.test(path)) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(bookingSiteHtml());
        return;
      }
      // Query-string params (e.g. ?from=&to=) are surfaced to handlers as the body,
      // so a GET can carry filters without a request body.
      const query: Record<string, string> = {};
      if (qIdx !== -1) new URLSearchParams(rawUrl.slice(qIdx + 1)).forEach((v, k) => { query[k] = v; });
      const bearer = req.headers['authorization'];
      const method = req.method ?? 'GET';
      let response;
      let closeAfter = false;
      try {
        const body = method === 'GET' || method === 'HEAD' ? query : { ...query, ...(await readJsonBody(req)) };
        const apiReq = { method, path, body, bearer };
        // /persist does durable I/O — the one async entry point on the App.
        response =
          apiReq.method === 'POST' && path === '/persist'
            ? await app.persist(apiReq)
            : app.dispatch(apiReq);
      } catch (e) {
        if (e instanceof PayloadTooLargeError) {
          // The client may still be streaming the oversized body; answer 413,
          // then close the connection once the response has flushed (keep-alive
          // can't be honored with an unconsumed request body).
          response = { status: 413, body: { error: e.message }, headers: { connection: 'close' } };
          closeAfter = true;
        } else {
          response = { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
        }
      }
      // A string body is written verbatim (e.g. Prometheus text at /metrics); any
      // other body is JSON-encoded. Handler-supplied headers (Retry-After, a
      // non-JSON content-type) merge over the JSON default.
      const isString = typeof response.body === 'string';
      const headers: Record<string, string> = { 'content-type': 'application/json', ...((response as { headers?: Record<string, string> }).headers ?? {}) };
      const payload = isString ? (response.body as string) : JSON.stringify(response.body);
      res.writeHead(response.status, headers);
      res.end(payload, () => {
        // Only after the response has flushed may an over-limit connection be
        // torn down — destroying earlier loses the 413 (client sees a reset).
        if (closeAfter) req.destroy();
      });
      try { hooks.onResponse?.({ method, path, status: response.status, bearer }); } catch { /* hook must never break a response */ }
    })();
  });
}
