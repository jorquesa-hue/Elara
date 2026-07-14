// Tranche 11 — edge write path: the Supabase Edge Function's projection is a
// verbatim twin of the kernel's, so the runtime write path that runs inside
// Supabase emits exactly the statements the kernel produces. This drift guard
// keeps the kernel the single source of truth (CLAUDE.md invariant spirit): if
// anyone hand-edits supabase/functions/persist-world/projection.ts out of step
// with src/persistence/project.ts, this fails. 2 tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Ledger,
  Agreement,
  Calendar,
  Billing,
  ACCOUNTS,
  Payments,
  Deposits,
  PolicyEnvelope,
  ExceptionQueue,
  AgentRuntime,
} from '../src/index.ts';
import { projectWorld as kernelProject, type WorldData } from '../src/persistence/project.ts';
import { projectWorld as edgeProject } from '../supabase/functions/persist-world/projection.ts';
import { persistWorldViaEdge, EdgePersistError } from '../src/persistence/edge-client.ts';

// Same representative world the persistence tranche exercises.
function buildWorld(): WorldData {
  const ledger = new Ledger();
  const billing = new Billing(ledger);
  const payments = new Payments(ledger, billing);
  const deposits = new Deposits(ledger);
  const calendar = new Calendar();
  const runtime = new AgentRuntime(new PolicyEnvelope(), new ExceptionQueue());

  const a = Agreement.create({
    id: 'ag-1',
    tenantId: 't-1',
    guestId: 'g-1',
    unitId: 'u-1',
    kind: 'nightly',
    start: '2026-07-01',
    end: '2026-07-05',
    rateCents: 20000,
    at: '2026-07-01T00:00:00Z',
  });
  runtime.execute('agreement.activate', { actor: 'agent' }, '2026-07-01T00:00:00Z', () =>
    a.activate('2026-07-01T00:00:00Z'),
  );
  calendar.hold({ id: 'ag-1-hold', unitId: 'u-1', holderId: 'ag-1', start: '2026-07-01', end: '2026-07-05' });
  runtime.execute('invoice.issue', { actor: 'agent' }, '2026-07-01T00:00:00Z', () =>
    billing.issue({
      id: 'inv-1',
      agreementId: 'ag-1',
      tenantId: 't-1',
      issuedAt: '2026-07-01T00:00:00Z',
      dueAt: '2026-07-05T00:00:00Z',
      lines: [{ description: '4 nights', account: ACCOUNTS.roomRevenue, amountCents: 80000 }],
    }),
  );
  payments.record({ id: 'pay-1', invoiceId: 'inv-1', amountCents: 80000, method: 'pix', receivedAt: '2026-07-02T00:00:00Z' });
  deposits.hold({ id: 'dep-1', agreementId: 'ag-1', amountCents: 50000, heldAt: '2026-07-02T00:00:00Z' });

  return {
    tenants: [{ id: 't-1', name: 'Rio Ops', displayName: 'Rio Ops', locale: 'pt-BR', currency: 'BRL', timezone: 'America/Sao_Paulo', businessStructure: 'short_stay', country: 'BR', jurisdiction: 'BR' }],
    units: [{ id: 'u-1', tenantId: 't-1', label: '101', code: 'RIO-101', active: true, typeId: 'utype-1br', propertyId: 'prop-riverside' }],
    unitTypes: [{ id: 'utype-1br', tenantId: 't-1', code: '1BR', name: 'One bedroom', bedrooms: 1, bathrooms: 1, maxGuests: 2, areaSqm: 52.5, baseRentCents: 250000, description: 'Garden view' }],
    properties: [{ id: 'prop-riverside', tenantId: 't-1', code: 'RIVERSIDE', name: 'Riverside', address: '1 River Rd', entityId: undefined }],
    guests: [{ id: 'g-1', tenantId: 't-1', fullName: 'Ana', code: 'G-1', email: 'ana@x.com' }],
    agreements: [{ id: 'ag-1', tenantId: 't-1', guestId: 'g-1', unitId: 'u-1', events: a.history }],
    holds: calendar.allHolds(),
    journalLines: ledger.allLines,
    invoices: billing.allInvoices(),
    payments: payments.all(),
    deposits: deposits.all(),
    actionLog: runtime.actionLog(),
    // master-data reshape v2 — exercise the new projection paths in the guard.
    legalEntities: [{ id: 'op', tenantId: 't-1', role: 'operator', name: 'Rio Op' }],
    parties: [{ id: 'p-1', tenantId: 't-1', kind: 'person', displayName: 'Ana', attributes: { vip: true } }],
    spaces: [
      { id: 's-prop', tenantId: 't-1', type: 'property', code: 'P', label: 'Prop', leasable: false },
      { id: 's-u', tenantId: 't-1', parentId: 's-prop', type: 'unit', code: '101', label: 'Unit', leasable: true },
    ],
    chargeTypes: [{ id: 'ct', tenantId: 't-1', code: 'rent', name: 'Rent', receivingEntityId: 'op', glAccount: 'revenue:room', recurring: true }],
    agreementParties: [{ agreementId: 'ag-1', partyId: 'p-1', role: 'resident' }],
    bills: [{ id: 'b-1', tenantId: 't-1', payeeId: 'p-1', propertyId: 'prop-1', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-15T00:00:00Z', currency: 'BRL', totalCents: 5000, paidCents: 0, status: 'open', lines: [{ description: 'x', account: 'expenses:supplier', amountCents: 5000 }] }],
    apPayments: [{ id: 'ap-1', billId: 'b-1', amountCents: 5000, method: 'pix', paidAt: '2026-07-10T00:00:00Z', status: 'settled' }],
    workOrders: [{ id: 'wo-1', tenantId: 't-1', spaceId: 's-u', title: 'Leak', priority: 'high', status: 'completed', assignedVendorPartyId: 'p-1', billId: 'b-1', openedAt: '2026-07-01T00:00:00Z', closedAt: '2026-07-03T00:00:00Z', resolution: 'fixed' }],
    reservations: [{ id: 'rv-1', tenantId: 't-1', spaceId: 's-u', holderPartyId: 'p-1', start: '2026-08-01T18:00:00Z', end: '2026-08-01T22:00:00Z', priceCents: 5000, currency: 'BRL', status: 'reserved', reservedAt: '2026-07-01T00:00:00Z' }],
    inspections: [{ id: 'insp-1', tenantId: 't-1', agreementId: 'ag-1', spaceId: 's-u', kind: 'move_out', status: 'completed', conductedAt: '2026-07-02T00:00:00Z', items: [{ area: 'kitchen', condition: 'damaged', note: 'burn' }], damageCents: 8000, createdAt: '2026-07-01T00:00:00Z' }],
    messageThreads: [{ id: 'th-1', tenantId: 't-1', subject: 'AC', kind: 'resident', status: 'open', agreementId: 'ag-1', partyId: 'p-1', createdAt: '2026-07-01T00:00:00Z' }],
    messages: [{ id: 'm-1', threadId: 'th-1', at: '2026-07-01T00:00:00Z', authorType: 'party', authorId: 'p-1', body: 'broken', direction: 'inbound' }],
    bankTransactions: [{ id: 'bt-1', tenantId: 't-1', postedAt: '2026-07-02T00:00:00Z', amountCents: 80000, description: 'PIX', status: 'matched', matchedType: 'payment', matchedId: 'pay-1', matchedAt: '2026-07-02T00:00:00Z' }],
    // feature wire-up — exercise the new projection paths in the guard.
    pricingRules: [{ id: 'pr-1', tenantId: 't-1', name: 'Studio', baseCents: 20000, minCents: 15000, maxCents: 60000, weekendFactorBps: 12000, occupancyTiers: [{ minOccupancyPct: 80, factorBps: 13000 }], losDiscounts: [{ minNights: 7, discountBps: 1000 }] }],
    purchaseOrders: [{ id: 'po-1', tenantId: 't-1', vendorId: 'p-1', createdAt: '2026-07-01T00:00:00Z', expectedAt: '2026-07-15T00:00:00Z', currency: 'BRL', totalCents: 200000, status: 'approved', billedCents: 0, approvedAt: '2026-07-01T00:00:00Z', lines: [{ description: 'Roof', account: 'expenses:repairs', amountCents: 200000 }] }],
    budgets: [{ id: 'bg-1', tenantId: 't-1', account: 'expenses:repairs', periodStart: '2026-07-01', periodEnd: '2026-08-01', amountCents: 1000000, label: 'July' }],
    prospects: [{ id: 'pros-1', tenantId: 't-1', name: 'Ava', partyId: 'p-1', preferences: { cleanliness: 4, social: 3, chronotype: 'early' } }],
    leads: [{ id: 'ld-1', tenantId: 't-1', name: 'Bea', source: 'website', stage: 'toured', estValueCents: 300000, partyId: 'p-1', createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z', stageAt: { new: '2026-07-01T00:00:00Z', toured: '2026-07-02T00:00:00Z' } }],
    applications: [{ id: 'app-1', tenantId: 't-1', leadId: 'ld-1', unitId: 'u-1', applicantName: 'Bea', applicantEmail: 'bea@x.com', incomeCents: 900000, status: 'approved', submittedAt: '2026-07-02T00:00:00Z', screening: { provider: 'transunion', reference: 'tu-1', recommendation: 'approve', creditScore: 720, completedAt: '2026-07-02T12:00:00Z' }, decidedAt: '2026-07-03T00:00:00Z', decidedBy: 'mgr' }],
    tours: [{ id: 'tour-1', tenantId: 't-1', leadId: 'ld-1', unitId: 'u-1', prospectName: 'Bea', prospectEmail: 'bea@x.com', scheduledAt: '2026-07-05T15:00:00Z', status: 'completed', agentId: 'agent-1', notes: 'liked it', createdAt: '2026-07-02T00:00:00Z', completedAt: '2026-07-05T15:30:00Z' }],
    unitTurns: [{ id: 'turn-1', tenantId: 't-1', unitId: 'u-1', status: 'ready', vacatedAt: '2026-07-01T00:00:00Z', readyAt: '2026-07-06T00:00:00Z', tasks: [{ key: 'clean', label: 'Deep clean', done: true, doneAt: '2026-07-03T00:00:00Z' }], agentId: 'agent-1', notes: 'quick turn', createdAt: '2026-07-01T00:00:00Z' }],
    pmSchedules: [{ id: 'pm-1', tenantId: 't-1', title: 'HVAC service', spaceId: 's-u', cadenceDays: 90, priority: 'medium', nextDueAt: '2026-08-01', lastRunAt: '2026-05-01T00:00:00Z', active: true, createdAt: '2026-05-01T00:00:00Z' }],
    insurancePolicies: [{ id: 'ins-1', tenantId: 't-1', agreementId: 'ag-1', partyId: 'p-1', carrier: 'Lemonade', policyNumber: 'POL-123', liabilityCents: 10000000, effectiveAt: '2026-06-01', expiresAt: '2027-06-01', status: 'active', verifiedAt: '2026-06-02T00:00:00Z', notes: 'certificate on file', createdAt: '2026-06-01T00:00:00Z' }],
    utilityBills: [{ id: 'util-1', tenantId: 't-1', propertyId: 'prop-1', utility: 'water', periodStart: '2026-06-01', periodEnd: '2026-07-01', totalCents: 90000, method: 'equal', status: 'billed', billedAt: '2026-07-02T00:00:00Z', notes: 'municipal water', createdAt: '2026-07-01T00:00:00Z' }],
    parcels: [{ id: 'pcl-1', tenantId: 't-1', partyId: 'p-1', agreementId: 'ag-1', carrier: 'UPS', trackingNumber: '1Z999', description: 'large box', location: 'Shelf B3', status: 'notified', receivedAt: '2026-07-10T00:00:00Z', notifiedAt: '2026-07-10T01:00:00Z', notes: 'fragile' }],
    waitlist: [{ id: 'wl-1', tenantId: 't-1', typeId: 'utype-1', propertyId: 'prop-1', prospectName: 'Dana Reed', prospectEmail: 'dana@x.com', prospectPhone: '555-0100', desiredMoveIn: '2026-09-01', status: 'offered', joinedAt: '2026-07-05T00:00:00Z', offeredAt: '2026-07-12T00:00:00Z', notes: 'wants a 2-bed' }],
    distributions: [{ id: 'dist-1', tenantId: 't-1', entityId: 'ent-1', propertyId: 'prop-1', amountCents: 400000, currency: 'BRL', periodStart: '2026-06-01', periodEnd: '2026-07-01', memo: 'Q2 draw', recordedAt: '2026-07-05T00:00:00Z' }],
    contributions: [{ id: 'contrib-1', tenantId: 't-1', entityId: 'ent-1', propertyId: 'prop-1', amountCents: 5000000, currency: 'BRL', memo: 'seed capital', recordedAt: '2026-01-05T00:00:00Z' }],
    // full persistence — exercise the config + platform + connector paths.
    users: [{ id: 'usr-1', tenantId: 't-1', code: 'U-1', displayName: 'Manager', roleId: 'manager', active: true }],
    customRoles: [{ tenantId: 't-1', roleId: 'housekeeping_lead', name: 'Housekeeping Lead', description: 'HK', permissions: ['agreement.read', 'maintenance.manage'] }],
    integrations: [{ id: 'int-1', tenantId: 't-1', kind: 'lock', provider: 'salto', status: 'active', config: { site: 'bldg-a' }, secretRef: 'salto-key', createdAt: '2026-07-01T00:00:00Z' }],
    connectorCommands: [{ id: 'cmd-1', tenantId: 't-1', integrationId: 'int-1', action: 'lock.unlock', payload: { spaceId: 's-u' }, status: 'succeeded', createdAt: '2026-07-01T00:00:00Z', dispatchedAt: '2026-07-01T00:01:00Z', resolvedAt: '2026-07-01T00:02:00Z', result: { code: 200 } }],
    notifications: [{ id: 'notif-1', tenantId: 't-1', channel: 'email', to: 'ana@x.com', kind: 'collections_reminder', data: { invoiceId: 'inv-1', amountCents: 100000 }, status: 'pending', createdAt: '2026-07-01T00:00:00Z' }],
    signatureEnvelopes: [{ id: 'env-1', tenantId: 't-1', documentName: 'Lease', provider: 'docusign', providerRef: 'ext-1', leadId: 'ld-1', agreementId: 'ag-1', signers: [{ name: 'Ana', email: 'ana@x.com', role: 'resident', signedAt: '2026-07-03T00:00:00Z' }], status: 'signed', createdAt: '2026-07-01T00:00:00Z', sentAt: '2026-07-01T00:05:00Z', completedAt: '2026-07-03T00:00:00Z' }],
    periodLocks: [{ tenantId: 't-1', period: '2026-06', status: 'closed', closedAt: '2026-07-01T00:00:00Z', closedBy: 'mgr' }],
    bankAccounts: [{ id: 'bank-trust-01', tenantId: 't-1', code: 'TRUST-01', name: 'Deposits Trust', kind: 'trust', glAccount: 'assets:cash:trust:trust-01', entityId: undefined }],
  };
}

test('edge projection is byte-identical to the kernel projection', () => {
  const w = buildWorld();
  // Cast: the edge copy inlines its own structural WorldData; the kernel world
  // satisfies it. We compare the produced statements, which is what ships.
  assert.deepEqual(edgeProject(w as never), kernelProject(w));
});

test('edge projection carries a balanced, FK-ordered batch', () => {
  const stmts = edgeProject(buildWorld() as never);
  const order = stmts.map((s) => s.text.match(/^insert into (\w+)/)?.[1] ?? '');
  assert.ok(order.indexOf('agreement') < order.indexOf('agreement_event'));
  let net = 0;
  for (const s of stmts) {
    if (!s.text.startsWith('insert into journal_line')) continue;
    net += (s.values[2] as number) - (s.values[3] as number);
  }
  assert.equal(net, 0);
});

test('edge client posts the world with a service-role bearer and parses the report', async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, statements: 21, trialBalance: 0, counts: { agreements: 1 } }),
    } as Response;
  }) as unknown as typeof fetch;

  const res = await persistWorldViaEdge(buildWorld(), {
    functionsUrl: 'https://ref.supabase.co/functions/v1/',
    serviceRoleKey: 'svc-key',
    fetchImpl,
  });

  assert.equal(res.statements, 21);
  assert.equal(res.trialBalance, 0);
  assert.equal(seen!.url, 'https://ref.supabase.co/functions/v1/persist-world');
  assert.equal(seen!.init.method, 'POST');
  assert.equal((seen!.init.headers as Record<string, string>).Authorization, 'Bearer svc-key');
  const sent = JSON.parse(seen!.init.body as string);
  assert.equal(sent.agreements.length, 1); // domain payload, not raw SQL
  assert.ok(!('text' in sent)); // never ships statements
});

test('edge client throws EdgePersistError on a non-200 (e.g. duplicate)', async () => {
  const fetchImpl = (async () => ({
    ok: false,
    status: 409,
    json: async () => ({ error: 'duplicate', code: '23505' }),
  } as Response)) as unknown as typeof fetch;

  await assert.rejects(
    () => persistWorldViaEdge(buildWorld(), { functionsUrl: 'https://ref.supabase.co/functions/v1', serviceRoleKey: 'k', fetchImpl }),
    (e: unknown) => e instanceof EdgePersistError && e.status === 409,
  );
});
