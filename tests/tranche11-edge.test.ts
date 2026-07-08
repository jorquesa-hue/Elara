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
    tenants: [{ id: 't-1', name: 'Rio Ops' }],
    units: [{ id: 'u-1', tenantId: 't-1', label: '101' }],
    guests: [{ id: 'g-1', tenantId: 't-1', fullName: 'Ana' }],
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
    bills: [{ id: 'b-1', tenantId: 't-1', payeeId: 'p-1', issuedAt: '2026-07-01T00:00:00Z', dueAt: '2026-07-15T00:00:00Z', currency: 'BRL', totalCents: 5000, paidCents: 0, status: 'open', lines: [{ description: 'x', account: 'expenses:supplier', amountCents: 5000 }] }],
    apPayments: [{ id: 'ap-1', billId: 'b-1', amountCents: 5000, method: 'pix', paidAt: '2026-07-10T00:00:00Z', status: 'settled' }],
    workOrders: [{ id: 'wo-1', tenantId: 't-1', spaceId: 's-u', title: 'Leak', priority: 'high', status: 'completed', assignedVendorPartyId: 'p-1', billId: 'b-1', openedAt: '2026-07-01T00:00:00Z', closedAt: '2026-07-03T00:00:00Z', resolution: 'fixed' }],
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
