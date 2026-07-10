// Thin node:http binding for the Public API. No third-party deps — the router
// (App.dispatch) is the real surface; this only marshals HTTP <-> ApiRequest.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { App } from './app.ts';
import { portalHtml } from './portal.ts';

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
      req.destroy();
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
      const path = (req.url ?? '/').split('?')[0]!;
      // Serve the operator portal SPA at the root; everything else is the API.
      if (req.method === 'GET' && (path === '/' || path === '/index.html' || path === '/portal')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(portalHtml());
        return;
      }
      const bearer = req.headers['authorization'];
      const method = req.method ?? 'GET';
      let response;
      try {
        const body = method === 'GET' || method === 'HEAD' ? {} : await readJsonBody(req);
        const apiReq = { method, path, body, bearer };
        // /persist does durable I/O — the one async entry point on the App.
        response =
          apiReq.method === 'POST' && path === '/persist'
            ? await app.persist(apiReq)
            : app.dispatch(apiReq);
      } catch (e) {
        response =
          e instanceof PayloadTooLargeError
            ? { status: 413, body: { error: e.message } }
            : { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
      }
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
      try { hooks.onResponse?.({ method, path, status: response.status, bearer }); } catch { /* hook must never break a response */ }
    })();
  });
}
