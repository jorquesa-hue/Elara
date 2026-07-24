// Thin node:http binding for the Public API. No third-party deps — the router
// (App.dispatch) is the real surface; this only marshals HTTP <-> ApiRequest.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { App } from './app.ts';
import { portalHtml } from './portal.ts';
import { residentHtml } from './resident.ts';
import { ownerHtml } from './owner.ts';
import { bookingSiteHtml, SEO_PLACEHOLDER } from './booking-site.ts';
import { siteSeo, type SiteListing } from '../booking-site.ts';

// Build the SEO/social <head> for a served booking site from its listing, so
// crawlers and link unfurlers see real content before the page hydrates.
function seoHead(listing: SiteListing): string {
  const seo = siteSeo(listing);
  const esc = (s: string) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const tags = [
    `<title>${esc(seo.title)}</title>`,
    `<meta name="description" content="${esc(seo.description)}"/>`,
    `<meta property="og:type" content="website"/>`,
    `<meta property="og:site_name" content="${esc(listing.displayName)}"/>`,
    `<meta property="og:title" content="${esc(seo.title)}"/>`,
    `<meta property="og:description" content="${esc(seo.description)}"/>`,
    `<meta name="twitter:card" content="${seo.image ? 'summary_large_image' : 'summary'}"/>`,
    `<meta name="twitter:title" content="${esc(seo.title)}"/>`,
    `<meta name="twitter:description" content="${esc(seo.description)}"/>`,
  ];
  if (seo.image) {
    tags.push(`<meta property="og:image" content="${esc(seo.image)}"/>`);
    tags.push(`<meta name="twitter:image" content="${esc(seo.image)}"/>`);
  }
  const ld: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'LodgingBusiness',
    name: listing.displayName,
    description: seo.description,
  };
  if (seo.image) ld['image'] = seo.image;
  const addr = listing.content?.location?.address;
  if (addr) ld['address'] = addr;
  // Escape "<" so a value can never break out of the <script> element.
  tags.push(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);
  return tags.join('\n');
}

// Render the booking microsite for a tenant (optionally scoped to one property),
// injecting the site context (so a custom-domain root knows which site to load)
// and best-effort SEO meta from the live listing.
function renderBookingSite(app: App, tenant: string, propertyCode?: string): string {
  const ctx = JSON.stringify({ tenant, property: propertyCode ?? null }).replace(/</g, '\\u003c');
  let head = `<script>window.__ELARA_SITE=${ctx}</script>`;
  try {
    const cfg = app.dispatch({ method: 'GET', path: `/site/${encodeURIComponent(tenant)}/config`, body: propertyCode ? { property: propertyCode } : {} });
    if (cfg.status === 200 && cfg.body) head += '\n' + seoHead(cfg.body as SiteListing);
  } catch { /* serve the static shell */ }
  return bookingSiteHtml().replace(SEO_PLACEHOLDER, head);
}

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
      // Serve the operator portal SPA at the root — UNLESS this request arrived on
      // a client's custom domain pointed at a booking site, in which case the root
      // renders that guest site (its API calls use absolute /site/... paths that
      // resolve normally on the same host).
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const hosted = app.siteForHost(req.headers.host);
        if (hosted) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(renderBookingSite(app, hosted.tenant, hosted.property));
          return;
        }
      }
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
      // The owner/investor SPA at /owner (entity-scoped once signed in).
      if (req.method === 'GET' && (path === '/owner' || path === '/owner/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(ownerHtml());
        return;
      }
      // Browsers auto-request /favicon.ico; answer 204 so it never hits the auth
      // gate (a harmless but noisy 401) on the portal or the public booking site.
      if (req.method === 'GET' && path === '/favicon.ico') {
        res.writeHead(204);
        res.end();
        return;
      }
      // The per-property public site at /site/<tenant>/p/<propertyCode>.
      const propSite = path.match(/^\/site\/([^/]+)\/p\/([^/]+)\/?$/);
      if (req.method === 'GET' && propSite) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderBookingSite(app, decodeURIComponent(propSite[1]!), decodeURIComponent(propSite[2]!)));
        return;
      }
      // The portfolio public site at /site/<tenant> (exactly two segments — deeper
      // paths like /site/<tenant>/availability are JSON API).
      if (req.method === 'GET' && /^\/site\/[^/]+\/?$/.test(path)) {
        const tenant = decodeURIComponent(path.replace(/^\/site\//, '').replace(/\/.*$/, ''));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderBookingSite(app, tenant));
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
