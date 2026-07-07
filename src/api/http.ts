// Thin node:http binding for the Public API. No third-party deps — the router
// (App.dispatch) is the real surface; this only marshals HTTP <-> ApiRequest.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { App } from './app.ts';

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
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

export function createHttpServer(app: App): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0]!;
      let response;
      try {
        const body = req.method === 'GET' || req.method === 'HEAD' ? {} : await readJsonBody(req);
        response = app.dispatch({
          method: req.method ?? 'GET',
          path,
          body,
          bearer: req.headers['authorization'],
        });
      } catch (e) {
        response = { status: 400, body: { error: e instanceof Error ? e.message : 'bad request' } };
      }
      res.writeHead(response.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response.body));
    })();
  });
}
