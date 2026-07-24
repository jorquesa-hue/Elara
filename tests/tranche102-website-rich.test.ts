// Tranche 102 — website module overhaul: rich content sections (gallery,
// highlights, location, FAQ, policies, testimonials), per-unit photo galleries +
// area, and the server-side SEO summary. Guards the pure model (sanitize), the
// engine pass-through (siteListing), and siteSeo.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeSiteContent, SiteContentError } from '../src/site-content.ts';
import { siteListing, siteSeo, type BookingSiteInput } from '../src/booking-site.ts';

test('sanitize keeps the new page sections and drops incomplete rows', () => {
  const c = sanitizeSiteContent({
    heroTitle: 'Stay downtown',
    heroSubtitle: 'Book direct',
    seoDescription: 'Modern homes with live pricing.',
    galleryPhotos: ['https://x/1.jpg', 'https://x/2.jpg', 42, '  '],
    highlights: ['Pool', 'Gym', ''],
    location: { address: '1 Main St', neighborhood: 'Old town', mapsQuery: 'Old town' },
    faqs: [{ q: 'Parking?', a: 'Yes' }, { q: 'no answer' }, { a: 'orphan' }],
    policies: [{ label: 'Check-in', value: '3 PM' }, { label: 'no value' }],
    testimonials: [{ quote: 'Great!', name: 'Ana', location: 'Rio' }, { quote: 'no name' }],
  });
  assert.equal(c.heroSubtitle, 'Book direct');
  assert.equal(c.seoDescription, 'Modern homes with live pricing.');
  assert.deepEqual(c.galleryPhotos, ['https://x/1.jpg', 'https://x/2.jpg']); // non-strings dropped
  assert.deepEqual(c.highlights, ['Pool', 'Gym']);
  assert.equal(c.location?.address, '1 Main St');
  assert.equal(c.faqs?.length, 1); // only the complete q+a pair
  assert.equal(c.policies?.length, 1); // only the complete label+value
  assert.equal(c.testimonials?.length, 1);
  assert.equal(c.testimonials?.[0]?.location, 'Rio');
});

test('sanitize rejects a malformed gallery/unit photo', () => {
  assert.throws(() => sanitizeSiteContent({ galleryPhotos: ['ftp://nope/x.jpg'] }), SiteContentError);
  assert.throws(() => sanitizeSiteContent({ units: { u1: { photos: ['javascript:alert(1)'] } } }), SiteContentError);
});

test('sanitize keeps per-unit area + photo gallery', () => {
  const c = sanitizeSiteContent({ units: { u1: { published: true, areaSqm: 85, photoDataUrl: 'https://x/cover.jpg', photos: ['https://x/a.jpg', 'https://x/b.jpg'] } } });
  assert.equal(c.units?.u1?.areaSqm, 85);
  assert.deepEqual(c.units?.u1?.photos, ['https://x/a.jpg', 'https://x/b.jpg']);
});

test('caps: gallery ≤ 12, unit photos ≤ 8, highlights ≤ 30', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `https://x/${i}.jpg`);
  const c = sanitizeSiteContent({ galleryPhotos: many(20), highlights: many(40).map(String), units: { u1: { photos: many(20) } } });
  assert.equal(c.galleryPhotos?.length, 12);
  assert.equal(c.highlights?.length, 30);
  assert.equal(c.units?.u1?.photos?.length, 8);
});

function baseInput(content: BookingSiteInput['content']): BookingSiteInput {
  return {
    tenantId: 't', displayName: 'Harbor Homes', currency: 'USD',
    units: [{ id: 'u1', label: 'Loft 1', active: true, typeId: 'ty1' }],
    unitTypes: [{ id: 'ty1', code: 'L', name: 'Loft', bedrooms: 1, bathrooms: 1, maxGuests: 2, areaSqm: 60 }],
    holds: [], agreements: [{ unitId: 'u1', rateCents: 250_00, start: '2026-01-01' }], content,
  };
}

test('siteListing passes page sections through and folds unit photos + inherited area', () => {
  const listing = siteListing(baseInput({
    heroTitle: 'Harbor', galleryPhotos: ['https://x/1.jpg'], highlights: ['Pool'],
    faqs: [{ q: 'Q', a: 'A' }], testimonials: [{ quote: 'Nice', name: 'Bo' }],
    units: { u1: { published: true, photos: ['https://x/u.jpg'] } },
  }));
  assert.deepEqual(listing.content.galleryPhotos, ['https://x/1.jpg']);
  assert.deepEqual(listing.content.highlights, ['Pool']);
  assert.equal(listing.content.faqs?.length, 1);
  assert.deepEqual(listing.units[0]?.details?.photos, ['https://x/u.jpg']);
  assert.equal(listing.units[0]?.details?.areaSqm, 60); // inherited from the floorplan
});

test('siteSeo: description precedence + prefers an https image', () => {
  const withSeo = siteSeo(siteListing(baseInput({ heroTitle: 'Harbor', seoDescription: 'The one line.', about: 'Long about.' })));
  assert.equal(withSeo.title, 'Harbor · Harbor Homes');
  assert.equal(withSeo.description, 'The one line.'); // seoDescription wins

  const fromAbout = siteSeo(siteListing(baseInput({ about: 'A lovely place by the water.' })));
  assert.equal(fromAbout.description, 'A lovely place by the water.'); // falls back to about

  const fallback = siteSeo(siteListing(baseInput({})));
  assert.match(fallback.description, /Harbor Homes/); // generated when nothing authored

  const img = siteSeo(siteListing(baseInput({
    heroPhotoDataUrl: 'data:image/png;base64,AAAA', // data: skipped for og
    units: { u1: { photos: ['https://cdn/real.jpg'] } },
  })));
  assert.equal(img.image, 'https://cdn/real.jpg');
});

test('empty content still produces a valid listing (back-compat)', () => {
  const listing = siteListing(baseInput({}));
  assert.equal(listing.units.length, 1);
  assert.equal(listing.content.galleryPhotos, undefined);
});
