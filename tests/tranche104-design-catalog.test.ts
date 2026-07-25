// Tranche 104 — the Website module's Design catalog. The sales team picks a design
// by looking at the REAL site rendered in it: the portal lays out one live microsite
// iframe per template, scaled down to a thumbnail. These tests guard the contract
// that catalog rests on — the markup/CSS the portal ships, and the ?chrome=0 preview
// param the thumbnails use to drop the "design preview" ribbon, and the stock
// photography a photo-less preview borrows so a design can be judged. 11 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { templateGallery, FEEL_KEYS, SEGMENT_KEYS, SEGMENT_LABELS, segmentFor, segmentForBusiness, SITE_TEMPLATES, PAIRINGS } from '../src/site-templates.ts';
import { bookingSiteHtml } from '../src/api/booking-site.ts';
import { App } from '../src/api/app.ts';
import { StaticTokenAuthenticator, type AuthContext } from '../src/api/context.ts';

const PORTAL = readFileSync(new URL('../src/api/portal.html', import.meta.url), 'utf8');
const SITE = bookingSiteHtml();
const NOW = '2026-07-25T00:00:00Z';

function seededApp() {
  const mgr: AuthContext = { actor: 'm', tenantId: 'jq', role: 'owner' };
  const app = new App({ authenticator: new StaticTokenAuthenticator({ mgr }), now: () => NOW });
  app.dispatch({ method: 'POST', path: '/demo/seed', bearer: 'Bearer mgr', body: {} });
  return app;
}

test('the portal ships the design-catalog markup contract (grid, card, thumb, filter)', () => {
  for (const cls of ['tplgrid', 'tplcard', 'tplthumb', 'tplmeta', 'tplswatch', 'tplfeel', 'tplfilter', 'tplchip']) {
    assert.ok(PORTAL.includes('.' + cls), `CSS for .${cls}`);
    assert.ok(PORTAL.includes('"' + cls) || PORTAL.includes(cls + '"'), `.${cls} used in markup`);
  }
});

test('a catalog thumbnail is a real microsite iframe laid out wide then scaled down', () => {
  // The whole point: the card shows the live site, not a swatch. Desktop layout
  // width + transform-origin top-left + a scale factor derived from the box width.
  assert.ok(PORTAL.includes('THUMB_W=1280'), 'desktop layout width');
  assert.ok(PORTAL.includes('transform-origin: top left'), 'scales from the top-left corner');
  assert.ok(PORTAL.includes('fr.style.transform="scale("+(wpx/THUMB_W)+")"'), 'scale derived from the rendered box width');
  assert.ok(PORTAL.includes('/site/"+encodeURIComponent(catTenant)+"?"+q.toString()'), 'targets the live microsite');
  assert.ok(PORTAL.includes('.tplthumb iframe { border: 0; transform-origin: top left; pointer-events: none;'),
    'the frame does not swallow the card click');
});

test('thumbnails load lazily and re-fit on resize (30 live frames is not free)', () => {
  assert.ok(PORTAL.includes('IntersectionObserver'), 'lazy-loads frames as they scroll in');
  assert.ok(PORTAL.includes('if(loaded) return; loaded=true;'), 'each frame loads at most once');
  assert.ok(PORTAL.includes('window.addEventListener("resize",function(){ thumbs.forEach'), 're-fits on resize');
});

test('picking a card still drives the saved template + the big live preview', () => {
  assert.ok(PORTAL.includes('pickedTemplate=tp.id; highlight(); refreshPreview();'), 'click picks + retargets');
  assert.ok(PORTAL.includes('classList.toggle("sel", id===pickedTemplate)'), 'selection is visible');
  assert.ok(PORTAL.includes('body.template = pickedTemplate'), 'the pick is what Save writes');
});

test('every template is filed under exactly one asset segment, all three in use', () => {
  const segs = templateGallery().map((t) => t.segment);
  assert.equal(segs.length, 36);
  for (const s of segs) assert.ok(SEGMENT_KEYS.includes(s), `${s} is a known segment`);
  assert.equal(new Set(segs).size, 3, 'multifamily, student and short-stay all populated');
  for (const key of SEGMENT_KEYS) {
    assert.ok(segs.filter((s) => s === key).length >= 5, `${key} has a real choice of designs`);
  }
  // Every template resolves a segment even without declaring one inline.
  for (const t of SITE_TEMPLATES) assert.ok(SEGMENT_KEYS.includes(segmentFor(t)), t.id);
  // The gallery carries the human label so the chip row cannot drift from the data.
  assert.equal(templateGallery().find((t) => t.id === 'metropolitan')!.segmentLabel, SEGMENT_LABELS.multifamily);
  assert.equal(templateGallery().find((t) => t.id === 'campushive')!.segment, 'student');
  assert.equal(templateGallery().find((t) => t.id === 'atlantica')!.segment, 'shortstay');
});

test('the catalog opens on the segment matching the operator\'s business', () => {
  assert.equal(segmentForBusiness('multifamily'), 'multifamily');
  assert.equal(segmentForBusiness('corporate_housing'), 'multifamily');
  assert.equal(segmentForBusiness('student_housing'), 'student');
  assert.equal(segmentForBusiness('short_stay'), 'shortstay');
  assert.equal(segmentForBusiness('boutique_hotel'), 'shortstay');
  assert.equal(segmentForBusiness('mixed_portfolio'), '', 'a mixed portfolio sees everything');
  assert.equal(segmentForBusiness(undefined), '');
  const app = seededApp();
  app.dispatch({ method: 'PUT', path: '/config', bearer: 'Bearer mgr', body: { businessStructure: 'student_housing' } });
  const res = app.dispatch({ method: 'GET', path: '/site-templates', bearer: 'Bearer mgr', body: {} });
  assert.equal((res.body as { recommendedSegment: string }).recommendedSegment, 'student');
  assert.ok(PORTAL.includes('segsPresent.indexOf(recommendedSegment)>=0'), 'the portal opens on it');
});

test('a filtered-out card is hidden, not destroyed (its frame stays loaded)', () => {
  assert.ok(PORTAL.includes('cardEls[id].style.display = (!activeSeg || cardSeg[id]===activeSeg) ? "" : "none"'));
  assert.ok(!PORTAL.includes('grid.innerHTML=""'), 'the grid is never rebuilt by the filter');
});

test('?thumb=1 trims the site to what a thumbnail shows (the catalog was slow)', () => {
  const app = seededApp();
  app.dispatch({ method: 'POST', path: '/units/bulk', bearer: 'Bearer mgr', body: { codePrefix: 'APT', count: 60, startNumber: 100 } });
  const full = app.dispatch({ method: 'GET', path: '/site/jq/config', body: { template: 'noir', demo: '1' } }).body as {
    units: unknown[]; floorplans: unknown[]; content: Record<string, unknown>;
  };
  const thumb = app.dispatch({ method: 'GET', path: '/site/jq/config', body: { template: 'noir', demo: '1', thumb: '1' } }).body as typeof full;
  assert.ok(full.units.length > 50, 'a real portfolio is large');
  assert.equal(thumb.units.length, 6, 'a thumbnail only ever shows the first row');
  assert.ok(thumb.floorplans.length <= 3);
  // Below-fold sections are invisible at thumbnail scale — do not build them.
  for (const k of ['faqs', 'testimonials', 'policies', 'highlights', 'location', 'about']) {
    assert.equal(thumb.content[k], undefined, `${k} dropped`);
  }
  assert.ok(JSON.stringify(thumb).length * 5 < JSON.stringify(full).length, 'dramatically smaller payload');
  // The design itself is untouched — that is the whole point of the thumbnail.
  assert.deepEqual(thumb.content['heroTitle'], full.content['heroTitle']);
  assert.equal((thumb as unknown as { theme: { id: string } }).theme.id, 'noir');
});

test('thumbnails load through a bounded queue, not thirty at once', () => {
  assert.ok(PORTAL.includes('var MAX_INFLIGHT=3'), 'a small concurrency window');
  assert.ok(PORTAL.includes('function enqueueFrame(fr,url)'), 'frames are queued, not fired immediately');
  assert.ok(PORTAL.includes('setTimeout(release, 8000)'), 'a slow frame cannot wedge the queue');
  assert.ok(PORTAL.includes('thumb: "1"'), 'and each asks for the trimmed site');
  assert.ok(PORTAL.includes('.replace("&thumb=1","")'), 'while "Open full" gets the real one');
});

test('?chrome=0 drops the preview ribbon so thumbnails are clean', () => {
  assert.ok(SITE.includes('PQS.get("chrome")!=="0"'), 'the microsite honors chrome=0');
  assert.ok(PORTAL.includes('template: tplId, demo: "1", chrome: "0"'), 'thumbnails request it');
  // …but "Open full ↗" opens the normal preview, ribbon and all.
  assert.ok(PORTAL.includes('openUrl: url.replace("&chrome=0","")'));
  assert.ok(PORTAL.includes('h("a",{href:th.openUrl'));
});

test('every gallery template a card is built from resolves a live preview URL', () => {
  const app = seededApp();
  const res = app.dispatch({ method: 'GET', path: '/site-templates', bearer: 'Bearer mgr', body: {} });
  assert.equal(res.status, 200);
  const tps = (res.body as { templates: Array<{ id: string; feel: string; swatch: string[] }> }).templates;
  assert.equal(tps.length, 36);
  for (const tp of tps) {
    // What the thumbnail asks for must actually theme the public site.
    const cfg = app.dispatch({ method: 'GET', path: '/site/jq/config', body: { template: tp.id, demo: '1', chrome: '0' } });
    assert.equal(cfg.status, 200, tp.id);
    const body = cfg.body as { theme: { id: string }; previewTemplate?: string };
    assert.equal(body.theme.id, tp.id, `${tp.id} themes the preview`);
    assert.equal(body.previewTemplate, tp.id);
    assert.ok(tp.swatch.length === 5 && tp.feel, `${tp.id} has card metadata`);
  }
});

test('a design preview of a real, photo-less portfolio borrows stock photography', () => {
  // THE BUG this closes: the photo-carrying sample only loaded for a tenant with
  // NO published units, so any real operator previewed their own photo-less
  // inventory and saw nothing but gradients — you cannot judge a design that way.
  const app = seededApp();
  const plain = app.dispatch({ method: 'GET', path: '/site/jq/config', body: {} }).body as {
    content: { heroPhotoDataUrl?: string; galleryPhotos?: string[] };
    units: Array<{ details?: { photoDataUrl?: string } }>;
    samplePhotos?: boolean;
  };
  // The PUBLIC site is untouched — nobody's live site silently sprouts stock photos.
  assert.equal(plain.content.heroPhotoDataUrl, undefined);
  assert.equal(plain.units.filter((u) => u.details?.photoDataUrl).length, 0);
  assert.equal(plain.samplePhotos, undefined);

  const prev = app.dispatch({ method: 'GET', path: '/site/jq/config', body: { template: 'noir', demo: '1' } }).body as typeof plain;
  assert.equal(prev.samplePhotos, true, 'flagged so the ribbon can say so');
  assert.ok(prev.content.heroPhotoDataUrl, 'hero gets a photo');
  assert.ok((prev.content.galleryPhotos ?? []).length >= 4, 'the gallery section fills');
  assert.equal(prev.units.filter((u) => u.details?.photoDataUrl).length, prev.units.length, 'every unit tile');
  assert.ok(prev.units.length > 1, 'a real portfolio, not the 3-unit sample');

  // Dressing a preview must never leak into saved content — otherwise a borrowed
  // photo would persist and show up on the operator's real, public site.
  const saved = app.dispatch({ method: 'GET', path: '/site-content', bearer: 'Bearer mgr', body: {} }).body as { content: { heroPhotoDataUrl?: string } };
  assert.equal(saved.content.heroPhotoDataUrl, undefined, 'the store is untouched');
  const again = app.dispatch({ method: 'GET', path: '/site/jq/config', body: {} }).body as typeof plain;
  assert.equal(again.content.heroPhotoDataUrl, undefined, 'the public site stays photo-less');
});

test('an operator photo always wins — dressing is a no-op once one exists', () => {
  const app = seededApp();
  const units = (app.dispatch({ method: 'GET', path: '/master-data', bearer: 'Bearer mgr', body: {} }).body as { units: Array<{ id: string }> }).units;
  const mine = 'https://cdn.example.com/my-building.jpg';
  app.dispatch({ method: 'PUT', path: '/site-content', bearer: 'Bearer mgr', body: { content: { units: { [units[0]!.id]: { published: true, photoDataUrl: mine } } } } });
  const prev = app.dispatch({ method: 'GET', path: '/site/jq/config', body: { template: 'noir', demo: '1' } }).body as {
    units: Array<{ id: string; details?: { photoDataUrl?: string } }>; samplePhotos?: boolean;
  };
  assert.equal(prev.samplePhotos, undefined, 'the listing has photography, so nothing is borrowed');
  assert.equal(prev.units.find((u) => u.id === units[0]!.id)?.details?.photoDataUrl, mine);
});

test('a photo URL that fails falls forward to a real photo before giving up', () => {
  // The stock CDN ids cannot be verified from a build, so the page must not
  // depend on any one of them resolving: one retry against a placeholder that
  // always resolves, then the template gradient. The retry marker terminates it.
  assert.ok(SITE.includes('function altPhoto(step,seed,w)'), 'a fallback source exists');
  // Step 1 is keyword-matched so a rescued tile still shows a home, not a random
  // photo — a design preview is meant to help you picture YOUR property there.
  assert.ok(SITE.includes('loremflickr.com'), 'the first fallback is property imagery');
  assert.ok(SITE.includes('"apartment,building":"apartment,interior"'), 'exterior vs interior keywords');
  assert.ok(SITE.includes('var ALT_STEPS = 2;'), 'a bounded chain');
  assert.ok(SITE.includes('if(step<ALT_STEPS){ t.setAttribute("data-alt",String(step+1))'), 'terminates');
  assert.ok(SITE.includes('t.style.display="none"'), 'then reveals the gradient');
  assert.ok(SITE.includes('var hstep=0; hpi.onerror=function(){ if(hstep<ALT_STEPS)'), 'the hero retries too');
  assert.ok(SITE.includes('cfg.samplePhotos?"Stock photos'), 'the ribbon is honest about borrowed photos');
});

test('student designs are a distinct register, not multifamily in another palette', () => {
  // The operator's complaint: the student examples looked like MF sites. UK/AU
  // PBSA sells to 18-year-olds — chunky geometric display type, pill buttons,
  // fat rounded cards, saturated colour. Lock that in so it cannot drift back.
  const students = SITE_TEMPLATES.filter((t) => segmentFor(t) === 'student');
  assert.equal(students.length, 6, 'a real choice of student designs');
  for (const t of students) {
    assert.equal(t.feel, 'student', `${t.id} carries the student feel`);
    assert.equal(t.radius, 'round', `${t.id} is round, not sharp/soft`);
    assert.ok(t.pairing, `${t.id} uses a display pairing`);
    // …and specifically a chunky geometric face, never a bookish serif.
    const display = PAIRINGS[t.pairing!].display.family;
    assert.match(display, /Outfit|Poppins|Archivo/, `${t.id} display face`);
    assert.doesNotMatch(display, /Georgia|Garamond|Playfair|Bodoni|Baskerville|Marcellus|Fraunces|Spectral|DM Serif/i,
      `${t.id} is not bookish`);
  }
  // No template outside the student segment borrows the student feel.
  for (const t of SITE_TEMPLATES) {
    if (segmentFor(t) !== 'student') assert.notEqual(t.feel, 'student', t.id);
  }
  // The old stand-ins were general-purpose looks; they are filed where they belong.
  for (const id of ['minima', 'zen', 'urbannest', 'palmcourt', 'loftworks', 'ipanema']) {
    assert.notEqual(segmentFor(SITE_TEMPLATES.find((t) => t.id === id)!), 'student', id);
  }
});

test('the microsite ships a student feel bundle distinct from the others', () => {
  assert.ok(SITE.includes('body[data-feel="student"]'), 'a student CSS bundle exists');
  assert.ok(SITE.includes('body[data-feel="student"] .btn{ border-radius:999px'), 'pill buttons');
  assert.ok(SITE.includes('body[data-feel="student"] h1{ font-weight:800'), 'chunky headlines');
  assert.ok(SITE.includes('body[data-feel="student"] .card{ border-radius:24px; border-width:2px'), 'fat cards');
  // The marker swash must be the heading's own background, not a negative-z
  // pseudo-element — that would paint behind the page background and vanish.
  assert.ok(SITE.includes('background-image:linear-gradient(var(--accent2),var(--accent2))'), 'marker swash');
  assert.ok(!SITE.includes('z-index:-1'), 'no negative-z swash');
  for (const feel of FEEL_KEYS) assert.ok(SITE.includes(`body[data-feel="${feel}"]`), `${feel} bundle`);
});
