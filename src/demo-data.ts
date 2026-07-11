// A realistic, deterministic sample portfolio generator — the "load sample data"
// seed a new tenant can pull to see every surface populated at once. It is PURE:
// buildDemoWorld(tenantId, at) returns plain record arrays keyed by stable ids
// (all prefixed `demo-`), and the App applies them FK-parents-first through the
// same kernel stores a real write would use. Nothing here touches the ledger or
// policy directly — the App's apply loop books each record through Billing /
// Payables / Agreement.create, so invariants (balanced journals, no double
// inventory) still hold on seeded data.
//
// The scenario is a MIXED short-let + rental + lease portfolio on Ilhabela (a
// beach island off São Paulo): nightly beach apartments, monthly temporada
// rentals, a long residential lease, a shared student room, and a commercial
// lease — plus guests, payers, a maintenance vendor, invoices (paid / open /
// overdue), deposits, vendor bills, work orders, a sales pipeline and a dynamic
// pricing rule. Given a fixed `at` it is fully reproducible.

export interface DemoUnit { code: string; label: string; active: boolean }
export interface DemoGuest { code: string; fullName: string; email: string }
export interface DemoParty {
  id: string; kind: 'person' | 'organization'; displayName: string;
  legalName?: string; taxId?: string; email?: string; phone?: string;
  attributes?: Record<string, unknown>;
}
export interface DemoAgreement {
  id: string; guestCode: string; unitCode: string;
  kind: 'nightly' | 'monthly' | 'lease';
  start: string; end: string; rateCents: number;
  activate: boolean; moveIn?: boolean;
  residentPartyId?: string; payerPartyId?: string; guarantorPartyId?: string;
}
export interface DemoInvoiceLine { description: string; account: string; amountCents: number }
export interface DemoInvoice {
  id: string; agreementId: string; issuedAt: string; dueAt: string;
  lines: DemoInvoiceLine[];
  /** If set, a payment of this many cents is recorded (full or partial). */
  payCents?: number; payMethod?: 'pix' | 'card' | 'transfer' | 'cash'; paidAt?: string;
}
export interface DemoDeposit { id: string; agreementId: string; amountCents: number; heldAt: string }
export interface DemoBill {
  id: string; payeeId: string; issuedAt: string; dueAt: string; memo?: string;
  lines: DemoInvoiceLine[];
  payCents?: number; payMethod?: 'pix' | 'transfer' | 'card' | 'cash'; paidAt?: string;
}
export interface DemoWorkOrder {
  id: string; title: string; description?: string; category?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent'; openedAt: string;
  requestedByPartyId?: string;
  assignVendorPartyId?: string; startedAt?: string;
  completedAt?: string; resolution?: string;
}
export interface DemoLead {
  id: string; name: string; source: string; estValueCents: number; createdAt: string;
  /** Advance the lead through these stages in order (each stamped at createdAt). */
  advanceTo?: ('toured' | 'applied' | 'approved' | 'signed' | 'lost')[];
}
export interface DemoPricingRule {
  id: string; name: string; baseCents: number; minCents: number; maxCents: number;
  weekendFactorBps: number;
  occupancyTiers: { minOccupancyPct: number; factorBps: number }[];
  losDiscounts: { minNights: number; discountBps: number }[];
}

export interface DemoWorld {
  tenantId: string;
  units: DemoUnit[];
  guests: DemoGuest[];
  parties: DemoParty[];
  pricingRules: DemoPricingRule[];
  agreements: DemoAgreement[];
  invoices: DemoInvoice[];
  deposits: DemoDeposit[];
  bills: DemoBill[];
  workOrders: DemoWorkOrder[];
  leads: DemoLead[];
}

const DAY = 86_400_000;

/** A `demo-` id is the seed marker: if the first unit already exists, don't re-seed. */
export const DEMO_MARKER_UNIT_ID = 'demo-unit-ILH-101';

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function isoStamp(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Build the Ilhabela mixed-portfolio sample world. `at` anchors every relative
 * date so overdue invoices land in the past and current stays span `at`.
 */
export function buildDemoWorld(tenantId: string, at: string): DemoWorld {
  const now = Date.parse(at);
  const d = (offsetDays: number) => isoDate(now + offsetDays * DAY);
  const t = (offsetDays: number) => isoStamp(now + offsetDays * DAY);

  const units: DemoUnit[] = [
    { code: 'ILH-101', label: 'Praia do Curral — Apto 101 (frente mar)', active: true },
    { code: 'ILH-102', label: 'Praia do Curral — Apto 102', active: true },
    { code: 'ILH-CASA', label: 'Casa Feiticeira (4 suítes, piscina)', active: true },
    { code: 'ILH-LOFT1', label: 'Vila — Loft 201 (temporada)', active: true },
    { code: 'ILH-LOFT2', label: 'Vila — Loft 202 (temporada)', active: true },
    { code: 'ILH-RES1', label: 'Residencial Perequê — Apto 33', active: true },
    { code: 'ILH-REP1', label: 'República Ilhabela — Quarto A', active: true },
    { code: 'ILH-COM1', label: 'Ponto Comercial Centro (loja)', active: true },
    { code: 'ILH-102B', label: 'Praia do Curral — Apto 103 (reforma)', active: false },
  ];

  const guests: DemoGuest[] = [
    { code: 'G-MARIA', fullName: 'Maria Fernanda Costa', email: 'maria.costa@example.com' },
    { code: 'G-JOAO', fullName: 'João Pedro Almeida', email: 'joao.almeida@example.com' },
    { code: 'G-LUCIA', fullName: 'Lúcia Ramos', email: 'lucia.ramos@example.com' },
    { code: 'G-CARLOS', fullName: 'Carlos Eduardo Nunes', email: 'carlos.nunes@example.com' },
    { code: 'G-BEATRIZ', fullName: 'Beatriz Oliveira', email: 'beatriz.oliveira@example.com' },
    { code: 'G-RAFAEL', fullName: 'Rafael Souza', email: 'rafael.souza@example.com' },
    { code: 'G-STUDENT', fullName: 'Tiago Martins (estudante)', email: 'tiago.martins@example.com' },
    { code: 'G-LOJA', fullName: 'Ateliê Maré Ltda', email: 'contato@atelie-mare.com.br' },
  ];

  const parties: DemoParty[] = [
    { id: 'demo-party-maria', kind: 'person', displayName: 'Maria Fernanda Costa', taxId: '111.222.333-44', email: 'maria.costa@example.com', phone: '+55 12 99111-0001' },
    { id: 'demo-party-joao', kind: 'person', displayName: 'João Pedro Almeida', taxId: '222.333.444-55', email: 'joao.almeida@example.com', phone: '+55 12 99111-0002' },
    { id: 'demo-party-lucia', kind: 'person', displayName: 'Lúcia Ramos', taxId: '333.444.555-66', email: 'lucia.ramos@example.com', phone: '+55 12 99111-0003' },
    { id: 'demo-party-carlos', kind: 'person', displayName: 'Carlos Eduardo Nunes', taxId: '444.555.666-77', email: 'carlos.nunes@example.com', phone: '+55 12 99111-0004' },
    { id: 'demo-party-guarantor', kind: 'person', displayName: 'Roberto Nunes (fiador)', taxId: '555.666.777-88', email: 'roberto.nunes@example.com', phone: '+55 12 99111-0005' },
    { id: 'demo-party-student', kind: 'person', displayName: 'Tiago Martins', taxId: '666.777.888-99', email: 'tiago.martins@example.com', phone: '+55 12 99111-0006' },
    { id: 'demo-party-parent', kind: 'person', displayName: 'Sônia Martins (responsável)', taxId: '777.888.999-00', email: 'sonia.martins@example.com', phone: '+55 12 99111-0007' },
    { id: 'demo-party-loja', kind: 'organization', displayName: 'Ateliê Maré Ltda', legalName: 'Ateliê Maré Comércio de Artesanato Ltda', taxId: '12.345.678/0001-90', email: 'contato@atelie-mare.com.br', phone: '+55 12 3896-0100' },
    { id: 'demo-party-vendor', kind: 'organization', displayName: 'Ilha Manutenção & Serviços', legalName: 'Ilha Manutenção e Serviços Prediais ME', taxId: '98.765.432/0001-10', email: 'os@ilhamanutencao.com.br', phone: '+55 12 3896-0200' },
  ];

  const pricingRules: DemoPricingRule[] = [
    {
      id: 'demo-price-praia',
      name: 'Praia do Curral — tarifa dinâmica',
      baseCents: 45_000, minCents: 32_000, maxCents: 120_000,
      weekendFactorBps: 13_000, // +30% Fri/Sat check-in
      occupancyTiers: [
        { minOccupancyPct: 60, factorBps: 11_000 },
        { minOccupancyPct: 85, factorBps: 13_500 },
      ],
      losDiscounts: [
        { minNights: 7, discountBps: 1_000 }, // -10% weekly
        { minNights: 28, discountBps: 2_000 }, // -20% monthly
      ],
    },
  ];

  // --- agreements: a mix of kinds + statuses ------------------------------
  const agreements: DemoAgreement[] = [
    // Active nightly beach stay spanning `at`.
    { id: 'demo-agr-nightly-1', guestCode: 'G-MARIA', unitCode: 'ILH-101', kind: 'nightly', start: d(-3), end: d(4), rateCents: 58_000, activate: true, moveIn: true, residentPartyId: 'demo-party-maria', payerPartyId: 'demo-party-maria' },
    // Upcoming nightly booking (draft — not activated yet).
    { id: 'demo-agr-nightly-2', guestCode: 'G-JOAO', unitCode: 'ILH-102', kind: 'nightly', start: d(20), end: d(27), rateCents: 52_000, activate: false, payerPartyId: 'demo-party-joao' },
    // Premium house, week-long, active.
    { id: 'demo-agr-nightly-3', guestCode: 'G-BEATRIZ', unitCode: 'ILH-CASA', kind: 'nightly', start: d(-1), end: d(6), rateCents: 145_000, activate: true, moveIn: true },
    // Monthly temporada, active, mid-term.
    { id: 'demo-agr-monthly-1', guestCode: 'G-CARLOS', unitCode: 'ILH-LOFT1', kind: 'monthly', start: d(-40), end: d(50), rateCents: 380_000, activate: true, moveIn: true, residentPartyId: 'demo-party-carlos', payerPartyId: 'demo-party-carlos' },
    // Monthly temporada, active, newer.
    { id: 'demo-agr-monthly-2', guestCode: 'G-LUCIA', unitCode: 'ILH-LOFT2', kind: 'monthly', start: d(-12), end: d(78), rateCents: 360_000, activate: true, moveIn: true, residentPartyId: 'demo-party-lucia', payerPartyId: 'demo-party-lucia' },
    // Long residential lease with a guarantor, active.
    { id: 'demo-agr-lease-1', guestCode: 'G-JOAO', unitCode: 'ILH-RES1', kind: 'lease', start: d(-200), end: d(165), rateCents: 285_000, activate: true, moveIn: true, residentPartyId: 'demo-party-joao', payerPartyId: 'demo-party-joao', guarantorPartyId: 'demo-party-guarantor' },
    // Shared student room — parent is the financial responsible.
    { id: 'demo-agr-lease-2', guestCode: 'G-STUDENT', unitCode: 'ILH-REP1', kind: 'lease', start: d(-60), end: d(300), rateCents: 130_000, activate: true, moveIn: true, residentPartyId: 'demo-party-student', payerPartyId: 'demo-party-parent' },
    // Commercial lease to the local shop, active.
    { id: 'demo-agr-lease-3', guestCode: 'G-LOJA', unitCode: 'ILH-COM1', kind: 'lease', start: d(-120), end: d(245), rateCents: 420_000, activate: true, moveIn: true, residentPartyId: 'demo-party-loja', payerPartyId: 'demo-party-loja' },
    // A completed past stay (activated, will be left active for simplicity of the seam).
    { id: 'demo-agr-nightly-4', guestCode: 'G-RAFAEL', unitCode: 'ILH-102', kind: 'nightly', start: d(-30), end: d(-24), rateCents: 49_000, activate: true, payerPartyId: 'demo-party-maria' },
  ];

  // --- invoices: paid, open, and overdue ----------------------------------
  const invoices: DemoInvoice[] = [
    // Nightly-1: paid in full (recent cash-in, inside the reporting window).
    { id: 'demo-inv-1', agreementId: 'demo-agr-nightly-1', issuedAt: t(-3), dueAt: d(-1), lines: [{ description: '7 diárias — Apto 101', account: 'revenue:nightly', amountCents: 406_000 }, { description: 'Taxa de limpeza', account: 'revenue:cleaning', amountCents: 18_000 }], payCents: 424_000, payMethod: 'pix', paidAt: t(-2) },
    // Casa: paid in full.
    { id: 'demo-inv-2', agreementId: 'demo-agr-nightly-3', issuedAt: t(-1), dueAt: d(1), lines: [{ description: '7 diárias — Casa Feiticeira', account: 'revenue:nightly', amountCents: 1_015_000 }, { description: 'Taxa de limpeza', account: 'revenue:cleaning', amountCents: 45_000 }], payCents: 1_060_000, payMethod: 'card', paidAt: t(-1) },
    // Monthly-1: July rent, open, due soon.
    { id: 'demo-inv-3', agreementId: 'demo-agr-monthly-1', issuedAt: t(-6), dueAt: d(4), lines: [{ description: 'Aluguel mensal — Loft 201', account: 'revenue:rent', amountCents: 380_000 }, { description: 'Condomínio', account: 'liabilities:due_to_condominium', amountCents: 65_000 }] },
    // Monthly-2: July rent, PARTIALLY paid.
    { id: 'demo-inv-4', agreementId: 'demo-agr-monthly-2', issuedAt: t(-5), dueAt: d(5), lines: [{ description: 'Aluguel mensal — Loft 202', account: 'revenue:rent', amountCents: 360_000 }], payCents: 180_000, payMethod: 'pix', paidAt: t(-3) },
    // Lease-1: June rent, OVERDUE (due 20 days ago, unpaid).
    { id: 'demo-inv-5', agreementId: 'demo-agr-lease-1', issuedAt: t(-45), dueAt: d(-20), lines: [{ description: 'Aluguel — Perequê 33 (junho)', account: 'revenue:rent', amountCents: 285_000 }] },
    // Lease-1: July rent, open.
    { id: 'demo-inv-6', agreementId: 'demo-agr-lease-1', issuedAt: t(-10), dueAt: d(2), lines: [{ description: 'Aluguel — Perequê 33 (julho)', account: 'revenue:rent', amountCents: 285_000 }] },
    // Student lease: OVERDUE (parent hasn't paid).
    { id: 'demo-inv-7', agreementId: 'demo-agr-lease-2', issuedAt: t(-40), dueAt: d(-32), lines: [{ description: 'Mensalidade — República Quarto A', account: 'revenue:rent', amountCents: 130_000 }] },
    // Commercial: paid.
    { id: 'demo-inv-8', agreementId: 'demo-agr-lease-3', issuedAt: t(-8), dueAt: d(-1), lines: [{ description: 'Aluguel comercial — Loja Centro', account: 'revenue:rent', amountCents: 420_000 }], payCents: 420_000, payMethod: 'transfer', paidAt: t(-4) },
    // Past nightly stay: paid.
    { id: 'demo-inv-9', agreementId: 'demo-agr-nightly-4', issuedAt: t(-30), dueAt: d(-24), lines: [{ description: '6 diárias — Apto 102', account: 'revenue:nightly', amountCents: 294_000 }], payCents: 294_000, payMethod: 'pix', paidAt: t(-28) },
  ];

  // --- deposits: caução held on the longer stays --------------------------
  const deposits: DemoDeposit[] = [
    { id: 'demo-dep-1', agreementId: 'demo-agr-lease-1', amountCents: 570_000, heldAt: t(-200) },
    { id: 'demo-dep-2', agreementId: 'demo-agr-lease-3', amountCents: 840_000, heldAt: t(-120) },
    { id: 'demo-dep-3', agreementId: 'demo-agr-monthly-1', amountCents: 380_000, heldAt: t(-40) },
    { id: 'demo-dep-4', agreementId: 'demo-agr-lease-2', amountCents: 130_000, heldAt: t(-60) },
  ];

  // --- vendor bills (AP): paid + open + overdue ---------------------------
  const bills: DemoBill[] = [
    { id: 'demo-bill-1', payeeId: 'demo-party-vendor', issuedAt: t(-15), dueAt: d(-2), memo: 'Reparo hidráulico — Casa Feiticeira', lines: [{ description: 'Mão de obra + material', account: 'expense:maintenance', amountCents: 120_000 }], payCents: 120_000, payMethod: 'pix', paidAt: t(-5) },
    { id: 'demo-bill-2', payeeId: 'demo-party-vendor', issuedAt: t(-9), dueAt: d(6), memo: 'Manutenção piscina (mensal)', lines: [{ description: 'Tratamento e limpeza', account: 'expense:maintenance', amountCents: 45_000 }] },
    { id: 'demo-bill-3', payeeId: 'demo-party-vendor', issuedAt: t(-35), dueAt: d(-14), memo: 'Pintura Apto 103 (reforma)', lines: [{ description: 'Serviço de pintura', account: 'expense:maintenance', amountCents: 260_000 }] },
  ];

  // --- work orders --------------------------------------------------------
  const workOrders: DemoWorkOrder[] = [
    { id: 'demo-wo-1', title: 'Ar-condicionado não gela — Apto 101', description: 'Hóspede relatou falha no split do quarto.', category: 'hvac', priority: 'high', openedAt: t(-1), requestedByPartyId: 'demo-party-maria', assignVendorPartyId: 'demo-party-vendor', startedAt: t(-1) },
    { id: 'demo-wo-2', title: 'Vazamento sob a pia — Loft 202', description: 'Infiltração na bancada da cozinha.', category: 'plumbing', priority: 'urgent', openedAt: t(-4), requestedByPartyId: 'demo-party-lucia', assignVendorPartyId: 'demo-party-vendor', startedAt: t(-3), completedAt: t(-2), resolution: 'Sifão substituído; sem mais vazamento.' },
    { id: 'demo-wo-3', title: 'Portão da garagem travando — Residencial Perequê', category: 'general', priority: 'normal', openedAt: t(-2), requestedByPartyId: 'demo-party-joao' },
    { id: 'demo-wo-4', title: 'Reforma Apto 103 — repintura e piso', description: 'Unidade fora de operação até conclusão.', category: 'renovation', priority: 'low', openedAt: t(-33), assignVendorPartyId: 'demo-party-vendor', startedAt: t(-30) },
  ];

  // --- CRM pipeline at various stages -------------------------------------
  const leads: DemoLead[] = [
    { id: 'demo-lead-1', name: 'Família Andrade — réveillon (Casa Feiticeira)', source: 'website', estValueCents: 1_400_000, createdAt: t(-2) },
    { id: 'demo-lead-2', name: 'Grupo corporativo — offsite 10 pax', source: 'referral', estValueCents: 2_200_000, createdAt: t(-9), advanceTo: ['toured'] },
    { id: 'demo-lead-3', name: 'Casal lua de mel — 5 diárias', source: 'airbnb', estValueCents: 320_000, createdAt: t(-14), advanceTo: ['toured', 'applied'] },
    { id: 'demo-lead-4', name: 'Locação anual — Perequê', source: 'website', estValueCents: 3_420_000, createdAt: t(-25), advanceTo: ['toured', 'applied', 'approved'] },
    { id: 'demo-lead-5', name: 'Temporada janeiro — Loft 201', source: 'instagram', estValueCents: 1_140_000, createdAt: t(-20), advanceTo: ['toured', 'applied', 'approved', 'signed'] },
    { id: 'demo-lead-6', name: 'Reserva cancelada — grupo carnaval', source: 'booking', estValueCents: 900_000, createdAt: t(-18), advanceTo: ['toured', 'lost'] },
  ];

  return { tenantId, units, guests, parties, pricingRules, agreements, invoices, deposits, bills, workOrders, leads };
}
