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

export interface DemoUnit { code: string; label: string; active: boolean; propertyCode?: string }
export interface DemoProperty { code: string; name: string; address?: string; entityCode?: string }
export interface DemoEntity { code: string; role: string; name: string; taxId?: string }
export interface DemoApplication { id: string; applicantName: string; applicantEmail?: string; leadId?: string; unitCode?: string; incomeCents?: number; submittedAt: string }
export interface DemoTour { id: string; prospectName: string; scheduledAt: string; prospectEmail?: string; leadId?: string; unitCode?: string; notes?: string; createdAt: string }
export interface DemoInsurance { id: string; agreementId: string; partyId?: string; carrier: string; policyNumber: string; liabilityCents: number; effectiveAt: string; expiresAt: string; createdAt: string }
export interface DemoUtilityBill { id: string; propertyCode: string; utility: string; method: string; periodStart: string; periodEnd: string; totalCents: number; createdAt: string }
export interface DemoParcel { id: string; partyId: string; carrier: string; receivedAt: string; agreementId?: string; description?: string; location?: string }
export interface DemoWaitlist { id: string; prospectName: string; propertyCode?: string; prospectEmail?: string; desiredMoveIn?: string; joinedAt: string }
export interface DemoCapitalMove { id: string; entityCode: string; propertyCode?: string; amountCents: number; recordedAt: string; memo?: string }
export interface DemoProspect { id: string; name: string; partyId?: string; preferences: Record<string, unknown> }
export interface DemoBudgetLine { category: 'revenue' | 'expense'; label: string; amountCents: number }
export interface DemoPropertyBudget { id: string; propertyCode: string; periodStart: string; periodEnd: string; lines: DemoBudgetLine[]; notes?: string }
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
  propertyCode?: string; // the community the expense belongs to (owner statements)
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
  properties: DemoProperty[];
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
  // Optional specialty-module data (populated by the European portfolio).
  legalEntities?: DemoEntity[];
  applications?: DemoApplication[];
  tours?: DemoTour[];
  insurancePolicies?: DemoInsurance[];
  utilityBills?: DemoUtilityBill[];
  parcels?: DemoParcel[];
  waitlist?: DemoWaitlist[];
  distributions?: DemoCapitalMove[];
  contributions?: DemoCapitalMove[];
  roommateProspects?: DemoProspect[];
  propertyBudgets?: DemoPropertyBudget[];
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

  // Two communities so per-property rollups (rent roll, occupancy, financials)
  // have real data to compare.
  const properties: DemoProperty[] = [
    { code: 'CURRAL', name: 'Praia do Curral', address: 'Av. Force, Ilhabela' },
    { code: 'VILA', name: 'Vila & Perequê', address: 'Perequê, Ilhabela' },
  ];
  const units: DemoUnit[] = [
    { code: 'ILH-101', label: 'Praia do Curral — Apto 101 (frente mar)', active: true, propertyCode: 'CURRAL' },
    { code: 'ILH-102', label: 'Praia do Curral — Apto 102', active: true, propertyCode: 'CURRAL' },
    { code: 'ILH-CASA', label: 'Casa Feiticeira (4 suítes, piscina)', active: true, propertyCode: 'CURRAL' },
    { code: 'ILH-LOFT1', label: 'Vila — Loft 201 (temporada)', active: true, propertyCode: 'VILA' },
    { code: 'ILH-LOFT2', label: 'Vila — Loft 202 (temporada)', active: true, propertyCode: 'VILA' },
    { code: 'ILH-RES1', label: 'Residencial Perequê — Apto 33', active: true, propertyCode: 'VILA' },
    { code: 'ILH-REP1', label: 'República Ilhabela — Quarto A', active: true, propertyCode: 'VILA' },
    { code: 'ILH-COM1', label: 'Ponto Comercial Centro (loja)', active: true, propertyCode: 'CURRAL' },
    { code: 'ILH-102B', label: 'Praia do Curral — Apto 103 (reforma)', active: false, propertyCode: 'CURRAL' },
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
    { id: 'demo-bill-1', payeeId: 'demo-party-vendor', propertyCode: 'CURRAL', issuedAt: t(-15), dueAt: d(-2), memo: 'Reparo hidráulico — Casa Feiticeira', lines: [{ description: 'Mão de obra + material', account: 'expense:maintenance', amountCents: 120_000 }], payCents: 120_000, payMethod: 'pix', paidAt: t(-5) },
    { id: 'demo-bill-2', payeeId: 'demo-party-vendor', propertyCode: 'CURRAL', issuedAt: t(-9), dueAt: d(6), memo: 'Manutenção piscina (mensal)', lines: [{ description: 'Tratamento e limpeza', account: 'expense:maintenance', amountCents: 45_000 }] },
    { id: 'demo-bill-3', payeeId: 'demo-party-vendor', propertyCode: 'VILA', issuedAt: t(-35), dueAt: d(-14), memo: 'Jardinagem e áreas comuns — Vila & Perequê', lines: [{ description: 'Serviço de paisagismo', account: 'expense:maintenance', amountCents: 260_000 }] },
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

  const byr = at.slice(0, 4);
  const propertyBudgets: DemoPropertyBudget[] = [
    { id: 'pbud-CURRAL', propertyCode: 'CURRAL', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, notes: 'FY operating plan', lines: [
      { category: 'revenue', label: 'Room & rent revenue', amountCents: 264_000_00 },
      { category: 'expense', label: 'Property management', amountCents: 26_400_00 },
      { category: 'expense', label: 'Repairs & maintenance', amountCents: 18_000_00 },
      { category: 'expense', label: 'Utilities', amountCents: 12_000_00 } ] },
    { id: 'pbud-VILA', propertyCode: 'VILA', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, notes: 'FY operating plan', lines: [
      { category: 'revenue', label: 'Room & rent revenue', amountCents: 123_000_00 },
      { category: 'expense', label: 'Property management', amountCents: 12_300_00 },
      { category: 'expense', label: 'Repairs & maintenance', amountCents: 9_000_00 } ] },
  ];
  return { tenantId, properties, units, guests, parties, pricingRules, agreements, invoices, deposits, bills, workOrders, leads, propertyBudgets };
}

/** Marker unit for the European portfolio (distinct from the Ilhabela one). */
export const EUROPE_MARKER_UNIT_ID = 'demo-unit-BER-101';

/**
 * A large European operator ("Meridian Living") across four communities:
 * two multifamily buildings that also run short-stay (Berlin, Amsterdam), one
 * pure long-lease multifamily (Munich), and a student campus (Berlin). Amounts
 * are in EUR cents. Mirrors the Ilhabela world's shape so it applies through the
 * same kernel loop (balanced journals, no double-booking).
 */
export function buildEuropeWorld(tenantId: string, at: string): DemoWorld {
  const now = Date.parse(at);
  const d = (o: number) => isoDate(now + o * DAY);
  const t = (o: number) => isoStamp(now + o * DAY);

  const legalEntities: DemoEntity[] = [
    { code: 'DE-SPE', role: 'spe', name: 'Meridian Deutschland SPE GmbH', taxId: 'DE-SPE-100200300' },
    { code: 'NL-SPE', role: 'spe', name: 'Meridian Nederland Vastgoed B.V.', taxId: 'NL-SPE-400500600' },
  ];
  const properties: DemoProperty[] = [
    { code: 'BER', name: 'Meridian Berlin Mitte', address: 'Torstraße 140, 10119 Berlin', entityCode: 'DE-SPE' },       // MF + short-stay
    { code: 'MUC', name: 'Meridian München Schwabing', address: 'Leopoldstraße 82, 80802 München', entityCode: 'DE-SPE' }, // MF, long-lease only
    { code: 'AMS', name: 'Meridian Amsterdam Zuid', address: 'Gustav Mahlerplein 12, 1082 Amsterdam', entityCode: 'NL-SPE' }, // MF + short-stay
    { code: 'CAMP', name: 'Meridian Campus Berlin', address: 'Ostendstraße 25, 12459 Berlin', entityCode: 'DE-SPE' },     // student housing
  ];
  const units: DemoUnit[] = [
    { code: 'BER-101', label: 'Berlin Mitte — Apt 1.01 (1BR)', active: true, propertyCode: 'BER' },
    { code: 'BER-204', label: 'Berlin Mitte — Apt 2.04 (2BR)', active: true, propertyCode: 'BER' },
    { code: 'BER-STU7', label: 'Berlin Mitte — Studio 0.7 (short-stay)', active: true, propertyCode: 'BER' },
    { code: 'BER-PH1', label: 'Berlin Mitte — Penthouse (short-stay)', active: true, propertyCode: 'BER' },
    { code: 'MUC-12', label: 'München Schwabing — Whg 12 (2BR)', active: true, propertyCode: 'MUC' },
    { code: 'MUC-14', label: 'München Schwabing — Whg 14 (3BR)', active: true, propertyCode: 'MUC' },
    { code: 'MUC-21', label: 'München Schwabing — Whg 21 (1BR)', active: true, propertyCode: 'MUC' },
    { code: 'MUC-GEW', label: 'München — Gewerbeeinheit EG (retail)', active: true, propertyCode: 'MUC' },
    { code: 'AMS-3A', label: 'Amsterdam Zuid — 3A (2BR)', active: true, propertyCode: 'AMS' },
    { code: 'AMS-5B', label: 'Amsterdam Zuid — 5B (studio, short-stay)', active: true, propertyCode: 'AMS' },
    { code: 'AMS-6C', label: 'Amsterdam Zuid — 6C (loft, short-stay)', active: true, propertyCode: 'AMS' },
    { code: 'CAMP-A12', label: 'Campus Berlin — Room A12 (shared flat)', active: true, propertyCode: 'CAMP' },
    { code: 'CAMP-A13', label: 'Campus Berlin — Room A13 (shared flat)', active: true, propertyCode: 'CAMP' },
    { code: 'CAMP-B04', label: 'Campus Berlin — Studio B04', active: true, propertyCode: 'CAMP' },
    { code: 'CAMP-B05', label: 'Campus Berlin — Studio B05', active: true, propertyCode: 'CAMP' },
    { code: 'AMS-7D', label: 'Amsterdam Zuid — 7D (refurb)', active: false, propertyCode: 'AMS' },
  ];
  const guests: DemoGuest[] = [
    { code: 'G-ANNA', fullName: 'Anna Schmidt', email: 'anna.schmidt@example.de' },
    { code: 'G-LUKAS', fullName: 'Lukas Weber', email: 'lukas.weber@example.de' },
    { code: 'G-SOFIA', fullName: 'Sofia Rossi', email: 'sofia.rossi@example.it' },
    { code: 'G-JEROEN', fullName: 'Jeroen de Vries', email: 'jeroen.devries@example.nl' },
    { code: 'G-CLARA', fullName: 'Clara Fontaine', email: 'clara.fontaine@example.fr' },
    { code: 'G-MAX', fullName: 'Maximilian Bauer', email: 'max.bauer@example.de' },
    { code: 'G-EMMA', fullName: 'Emma Janssen', email: 'emma.janssen@example.nl' },
    { code: 'G-STU1', fullName: 'Noah Keller (student)', email: 'noah.keller@uni-berlin.de' },
    { code: 'G-STU2', fullName: 'Mia Hofer (student)', email: 'mia.hofer@uni-berlin.de' },
    { code: 'G-SHOP', fullName: 'Café Nordlicht GmbH', email: 'hallo@cafe-nordlicht.de' },
  ];
  const parties: DemoParty[] = [
    { id: 'demo-party-anna', kind: 'person', displayName: 'Anna Schmidt', taxId: 'DE-11-222-3334', email: 'anna.schmidt@example.de', phone: '+49 30 5550 0001' },
    { id: 'demo-party-lukas', kind: 'person', displayName: 'Lukas Weber', taxId: 'DE-22-333-4445', email: 'lukas.weber@example.de', phone: '+49 89 5550 0002' },
    { id: 'demo-party-sofia', kind: 'person', displayName: 'Sofia Rossi', taxId: 'IT-33-444-5556', email: 'sofia.rossi@example.it', phone: '+39 02 5550 0003' },
    { id: 'demo-party-jeroen', kind: 'person', displayName: 'Jeroen de Vries', taxId: 'NL-44-555-6667', email: 'jeroen.devries@example.nl', phone: '+31 20 5550 0004' },
    { id: 'demo-party-clara', kind: 'person', displayName: 'Clara Fontaine', taxId: 'FR-55-666-7778', email: 'clara.fontaine@example.fr', phone: '+33 1 5550 0005' },
    { id: 'demo-party-emma', kind: 'person', displayName: 'Emma Janssen', taxId: 'NL-66-777-8889', email: 'emma.janssen@example.nl', phone: '+31 20 5550 0006' },
    { id: 'demo-party-eu-guarantor', kind: 'person', displayName: 'Heinrich Weber (Bürge)', taxId: 'DE-77-888-9990', email: 'h.weber@example.de', phone: '+49 89 5550 0007' },
    { id: 'demo-party-stu1', kind: 'person', displayName: 'Noah Keller', taxId: 'DE-88-999-0001', email: 'noah.keller@uni-berlin.de', phone: '+49 30 5550 0008' },
    { id: 'demo-party-stu2', kind: 'person', displayName: 'Mia Hofer', taxId: 'DE-99-000-1112', email: 'mia.hofer@uni-berlin.de', phone: '+49 30 5550 0009' },
    { id: 'demo-party-eu-parent', kind: 'person', displayName: 'Petra Keller (Elternteil)', taxId: 'DE-10-111-2223', email: 'petra.keller@example.de', phone: '+49 30 5550 0010' },
    { id: 'demo-party-shop', kind: 'organization', displayName: 'Café Nordlicht GmbH', legalName: 'Café Nordlicht Gastronomie GmbH', taxId: 'DE-812345678', email: 'hallo@cafe-nordlicht.de', phone: '+49 89 5550 0100' },
    { id: 'demo-party-eu-vendor', kind: 'organization', displayName: 'EuroFM Facility Services', legalName: 'EuroFM Facility Services GmbH', taxId: 'DE-887654321', email: 'service@eurofm.eu', phone: '+49 30 5550 0200' },
  ];
  const pricingRules: DemoPricingRule[] = [
    {
      id: 'demo-price-berlin', name: 'Berlin short-stay — dynamic',
      baseCents: 14_000, minCents: 9_000, maxCents: 42_000, weekendFactorBps: 13_000,
      occupancyTiers: [{ minOccupancyPct: 65, factorBps: 11_500 }, { minOccupancyPct: 88, factorBps: 14_000 }],
      losDiscounts: [{ minNights: 7, discountBps: 1_200 }, { minNights: 28, discountBps: 2_500 }],
    },
  ];

  const agreements: DemoAgreement[] = [
    // Berlin MF long leases
    { id: 'demo-agr-ber-1', guestCode: 'G-ANNA', unitCode: 'BER-101', kind: 'lease', start: d(-210), end: d(155), rateCents: 148_000, activate: true, moveIn: true, residentPartyId: 'demo-party-anna', payerPartyId: 'demo-party-anna' },
    { id: 'demo-agr-ber-2', guestCode: 'G-MAX', unitCode: 'BER-204', kind: 'lease', start: d(-95), end: d(270), rateCents: 219_000, activate: true, moveIn: true, residentPartyId: 'demo-party-anna', payerPartyId: 'demo-party-anna', guarantorPartyId: 'demo-party-eu-guarantor' },
    // Berlin short-stay
    { id: 'demo-agr-ber-3', guestCode: 'G-CLARA', unitCode: 'BER-STU7', kind: 'nightly', start: d(-2), end: d(5), rateCents: 16_500, activate: true, moveIn: true, payerPartyId: 'demo-party-clara' },
    { id: 'demo-agr-ber-4', guestCode: 'G-SOFIA', unitCode: 'BER-PH1', kind: 'nightly', start: d(14), end: d(19), rateCents: 38_000, activate: false, payerPartyId: 'demo-party-sofia' },
    // Munich MF long leases (no short-stay)
    { id: 'demo-agr-muc-1', guestCode: 'G-LUKAS', unitCode: 'MUC-12', kind: 'lease', start: d(-320), end: d(45), rateCents: 232_000, activate: true, moveIn: true, residentPartyId: 'demo-party-lukas', payerPartyId: 'demo-party-lukas', guarantorPartyId: 'demo-party-eu-guarantor' },
    { id: 'demo-agr-muc-2', guestCode: 'G-SOFIA', unitCode: 'MUC-14', kind: 'lease', start: d(-150), end: d(215), rateCents: 298_000, activate: true, moveIn: true, residentPartyId: 'demo-party-sofia', payerPartyId: 'demo-party-sofia' },
    { id: 'demo-agr-muc-3', guestCode: 'G-SHOP', unitCode: 'MUC-GEW', kind: 'lease', start: d(-260), end: d(470), rateCents: 410_000, activate: true, moveIn: true, residentPartyId: 'demo-party-shop', payerPartyId: 'demo-party-shop' },
    // Amsterdam MF + short-stay
    { id: 'demo-agr-ams-1', guestCode: 'G-JEROEN', unitCode: 'AMS-3A', kind: 'monthly', start: d(-30), end: d(60), rateCents: 245_000, activate: true, moveIn: true, residentPartyId: 'demo-party-jeroen', payerPartyId: 'demo-party-jeroen' },
    { id: 'demo-agr-ams-2', guestCode: 'G-EMMA', unitCode: 'AMS-5B', kind: 'nightly', start: d(-1), end: d(6), rateCents: 19_000, activate: true, moveIn: true, payerPartyId: 'demo-party-emma' },
    // Student campus — parent is the financial responsible on one
    { id: 'demo-agr-camp-1', guestCode: 'G-STU1', unitCode: 'CAMP-A12', kind: 'lease', start: d(-70), end: d(295), rateCents: 62_000, activate: true, moveIn: true, residentPartyId: 'demo-party-stu1', payerPartyId: 'demo-party-eu-parent' },
    { id: 'demo-agr-camp-2', guestCode: 'G-STU2', unitCode: 'CAMP-B04', kind: 'lease', start: d(-40), end: d(325), rateCents: 74_000, activate: true, moveIn: true, residentPartyId: 'demo-party-stu2', payerPartyId: 'demo-party-stu2' },
    // A completed past short-stay
    { id: 'demo-agr-ber-5', guestCode: 'G-EMMA', unitCode: 'BER-STU7', kind: 'nightly', start: d(-25), end: d(-20), rateCents: 15_000, activate: true, payerPartyId: 'demo-party-emma' },
  ];

  const invoices: DemoInvoice[] = [
    { id: 'demo-inv-e1', agreementId: 'demo-agr-ber-1', issuedAt: t(-8), dueAt: d(2), lines: [{ description: 'Kaltmiete — Apt 1.01 (Juli)', account: 'revenue:rent', amountCents: 148_000 }, { description: 'Nebenkosten', account: 'revenue:utility_reimbursement', amountCents: 32_000 }], payCents: 180_000, payMethod: 'transfer', paidAt: t(-6) },
    { id: 'demo-inv-e2', agreementId: 'demo-agr-ber-2', issuedAt: t(-6), dueAt: d(4), lines: [{ description: 'Kaltmiete — Apt 2.04 (Juli)', account: 'revenue:rent', amountCents: 219_000 }] },
    { id: 'demo-inv-e3', agreementId: 'demo-agr-ber-3', issuedAt: t(-2), dueAt: d(-1), lines: [{ description: '7 Nächte — Studio 0.7', account: 'revenue:nightly', amountCents: 115_500 }, { description: 'Endreinigung', account: 'revenue:cleaning', amountCents: 9_000 }], payCents: 124_500, payMethod: 'card', paidAt: t(-2) },
    { id: 'demo-inv-e4', agreementId: 'demo-agr-muc-1', issuedAt: t(-40), dueAt: d(-22), lines: [{ description: 'Miete — Whg 12 (Juni)', account: 'revenue:rent', amountCents: 232_000 }] }, // overdue
    { id: 'demo-inv-e5', agreementId: 'demo-agr-muc-1', issuedAt: t(-9), dueAt: d(3), lines: [{ description: 'Miete — Whg 12 (Juli)', account: 'revenue:rent', amountCents: 232_000 }] },
    { id: 'demo-inv-e6', agreementId: 'demo-agr-muc-2', issuedAt: t(-7), dueAt: d(3), lines: [{ description: 'Miete — Whg 14 (Juli)', account: 'revenue:rent', amountCents: 298_000 }], payCents: 149_000, payMethod: 'transfer', paidAt: t(-4) }, // partial
    { id: 'demo-inv-e7', agreementId: 'demo-agr-muc-3', issuedAt: t(-8), dueAt: d(-2), lines: [{ description: 'Gewerbemiete — EG (Juli)', account: 'revenue:rent', amountCents: 410_000 }], payCents: 410_000, payMethod: 'transfer', paidAt: t(-3) },
    { id: 'demo-inv-e8', agreementId: 'demo-agr-ams-1', issuedAt: t(-10), dueAt: d(1), lines: [{ description: 'Huur — 3A (juli)', account: 'revenue:rent', amountCents: 245_000 }], payCents: 245_000, payMethod: 'transfer', paidAt: t(-8) },
    { id: 'demo-inv-e9', agreementId: 'demo-agr-ams-2', issuedAt: t(-1), dueAt: d(1), lines: [{ description: '7 nachten — Studio 5B', account: 'revenue:nightly', amountCents: 133_000 }, { description: 'Schoonmaak', account: 'revenue:cleaning', amountCents: 8_000 }], payCents: 141_000, payMethod: 'card', paidAt: t(-1) },
    { id: 'demo-inv-e10', agreementId: 'demo-agr-camp-1', issuedAt: t(-35), dueAt: d(-27), lines: [{ description: 'Miete — Room A12 (Juni)', account: 'revenue:rent', amountCents: 62_000 }] }, // student overdue
    { id: 'demo-inv-e11', agreementId: 'demo-agr-camp-2', issuedAt: t(-6), dueAt: d(6), lines: [{ description: 'Miete — Studio B04 (Juli)', account: 'revenue:rent', amountCents: 74_000 }], payCents: 74_000, payMethod: 'pix', paidAt: t(-5) },
    { id: 'demo-inv-e12', agreementId: 'demo-agr-ber-5', issuedAt: t(-25), dueAt: d(-20), lines: [{ description: '5 Nächte — Studio 0.7', account: 'revenue:nightly', amountCents: 75_000 }], payCents: 75_000, payMethod: 'card', paidAt: t(-24) },
  ];

  const deposits: DemoDeposit[] = [
    { id: 'demo-dep-e1', agreementId: 'demo-agr-ber-1', amountCents: 444_000, heldAt: t(-210) },
    { id: 'demo-dep-e2', agreementId: 'demo-agr-ber-2', amountCents: 657_000, heldAt: t(-95) },
    { id: 'demo-dep-e3', agreementId: 'demo-agr-muc-1', amountCents: 696_000, heldAt: t(-320) },
    { id: 'demo-dep-e4', agreementId: 'demo-agr-muc-3', amountCents: 1_230_000, heldAt: t(-260) },
    { id: 'demo-dep-e5', agreementId: 'demo-agr-camp-1', amountCents: 62_000, heldAt: t(-70) },
  ];

  const bills: DemoBill[] = [
    { id: 'demo-bill-e1', payeeId: 'demo-party-eu-vendor', propertyCode: 'BER', issuedAt: t(-14), dueAt: d(-1), memo: 'Aufzugswartung — Berlin Mitte', lines: [{ description: 'Wartungsvertrag Q3', account: 'expense:maintenance', amountCents: 180_000 }], payCents: 180_000, payMethod: 'transfer', paidAt: t(-6) },
    { id: 'demo-bill-e2', payeeId: 'demo-party-eu-vendor', propertyCode: 'MUC', issuedAt: t(-10), dueAt: d(7), memo: 'Treppenhausreinigung (monatlich)', lines: [{ description: 'Reinigung Juli', account: 'expense:cleaning', amountCents: 68_000 }] },
    { id: 'demo-bill-e3', payeeId: 'demo-party-eu-vendor', propertyCode: 'AMS', issuedAt: t(-30), dueAt: d(-12), memo: 'Tuinonderhoud — Amsterdam Zuid', lines: [{ description: 'Groenonderhoud Q2', account: 'expense:maintenance', amountCents: 145_000 }] }, // overdue
    { id: 'demo-bill-e4', payeeId: 'demo-party-eu-vendor', propertyCode: 'CAMP', issuedAt: t(-5), dueAt: d(20), memo: 'WLAN & Zutrittssystem — Campus', lines: [{ description: 'Netzwerk + Schließanlage', account: 'expense:utilities', amountCents: 96_000 }] },
  ];

  const workOrders: DemoWorkOrder[] = [
    { id: 'demo-wo-e1', title: 'Heizung fällt aus — Whg 14 (München)', description: 'Mieter meldet kalte Heizkörper im Wohnzimmer.', category: 'hvac', priority: 'high', openedAt: t(-1), requestedByPartyId: 'demo-party-sofia', assignVendorPartyId: 'demo-party-eu-vendor', startedAt: t(-1) },
    { id: 'demo-wo-e2', title: 'Wasserschaden Küche — 3A (Amsterdam)', description: 'Lek onder de gootsteen.', category: 'plumbing', priority: 'urgent', openedAt: t(-4), requestedByPartyId: 'demo-party-jeroen', assignVendorPartyId: 'demo-party-eu-vendor', startedAt: t(-3), completedAt: t(-2), resolution: 'Sifon vervangen; geen lekkage meer.' },
    { id: 'demo-wo-e3', title: 'Zutrittstür klemmt — Campus B-Flügel', category: 'general', priority: 'normal', openedAt: t(-2), requestedByPartyId: 'demo-party-stu2' },
    { id: 'demo-wo-e4', title: 'Renovierung 7D — Streichen & Boden', description: 'Einheit bis Fertigstellung außer Betrieb.', category: 'renovation', priority: 'low', openedAt: t(-33), assignVendorPartyId: 'demo-party-eu-vendor', startedAt: t(-30) },
  ];

  const leads: DemoLead[] = [
    { id: 'demo-lead-e1', name: 'Corporate relocation — 2BR Berlin', source: 'website', estValueCents: 2_600_000, createdAt: t(-2) },
    { id: 'demo-lead-e2', name: 'Erasmus intake — 6 rooms Campus', source: 'university', estValueCents: 4_400_000, createdAt: t(-9), advanceTo: ['toured'] },
    { id: 'demo-lead-e3', name: 'Short-stay — penthouse Berlin (5 nts)', source: 'booking', estValueCents: 190_000, createdAt: t(-14), advanceTo: ['toured', 'applied'] },
    { id: 'demo-lead-e4', name: 'Family lease — 3BR München', source: 'referral', estValueCents: 3_576_000, createdAt: t(-25), advanceTo: ['toured', 'applied', 'approved'] },
    { id: 'demo-lead-e5', name: 'Annual — loft Amsterdam', source: 'ils', estValueCents: 2_940_000, createdAt: t(-20), advanceTo: ['toured', 'applied', 'approved', 'signed'] },
    { id: 'demo-lead-e6', name: 'Group booking — cancelled', source: 'instagram', estValueCents: 800_000, createdAt: t(-18), advanceTo: ['toured', 'lost'] },
  ];

  // --- specialty modules ---------------------------------------------------
  const applications: DemoApplication[] = [
    { id: 'demo-app-e1', applicantName: 'Noah Keller', applicantEmail: 'noah.keller@uni-berlin.de', leadId: 'demo-lead-e2', unitCode: 'CAMP-A13', incomeCents: 120_000, submittedAt: t(-8) },
    { id: 'demo-app-e2', applicantName: 'Sofia Rossi', applicantEmail: 'sofia.rossi@example.it', leadId: 'demo-lead-e4', unitCode: 'MUC-14', incomeCents: 620_000, submittedAt: t(-12) },
  ];
  const tours: DemoTour[] = [
    { id: 'demo-tour-e1', prospectName: 'Erasmus group (6)', prospectEmail: 'housing@uni-berlin.de', leadId: 'demo-lead-e2', unitCode: 'CAMP-B05', scheduledAt: t(3), notes: 'Group viewing of the B-wing studios.', createdAt: t(-9) },
    { id: 'demo-tour-e2', prospectName: 'Familie Bauer', leadId: 'demo-lead-e4', unitCode: 'MUC-14', scheduledAt: t(2), createdAt: t(-25) },
  ];
  const insurancePolicies: DemoInsurance[] = [
    { id: 'demo-ins-e1', agreementId: 'demo-agr-ber-1', partyId: 'demo-party-anna', carrier: 'Allianz', policyNumber: 'AZ-DE-88121', liabilityCents: 5_000_000, effectiveAt: d(-210), expiresAt: d(155), createdAt: t(-208) },
    { id: 'demo-ins-e2', agreementId: 'demo-agr-muc-1', partyId: 'demo-party-lukas', carrier: 'HUK-Coburg', policyNumber: 'HUK-77234', liabilityCents: 5_000_000, effectiveAt: d(-320), expiresAt: d(45), createdAt: t(-318) },
    { id: 'demo-ins-e3', agreementId: 'demo-agr-ams-1', partyId: 'demo-party-jeroen', carrier: 'Centraal Beheer', policyNumber: 'CB-NL-4021', liabilityCents: 5_000_000, effectiveAt: d(-30), expiresAt: d(60), createdAt: t(-28) },
  ];
  const utilityBills: DemoUtilityBill[] = [
    { id: 'demo-util-e1', propertyCode: 'BER', utility: 'water', method: 'occupancy', periodStart: d(-60), periodEnd: d(-30), totalCents: 92_000, createdAt: t(-28) },
    { id: 'demo-util-e2', propertyCode: 'MUC', utility: 'gas', method: 'area', periodStart: d(-60), periodEnd: d(-30), totalCents: 214_000, createdAt: t(-27) },
  ];
  const parcels: DemoParcel[] = [
    { id: 'demo-par-e1', partyId: 'demo-party-anna', carrier: 'DHL', receivedAt: t(-1), agreementId: 'demo-agr-ber-1', description: 'Amazon box (medium)', location: 'Mailroom shelf B3' },
    { id: 'demo-par-e2', partyId: 'demo-party-jeroen', carrier: 'PostNL', receivedAt: t(-2), agreementId: 'demo-agr-ams-1', description: 'Registered letter', location: 'Front desk' },
    { id: 'demo-par-e3', partyId: 'demo-party-stu2', carrier: 'Hermes', receivedAt: t(0), description: 'Two parcels', location: 'Campus office' },
  ];
  const waitlist: DemoWaitlist[] = [
    { id: 'demo-wl-e1', prospectName: 'Jonas Meier', prospectEmail: 'jonas.meier@uni-berlin.de', propertyCode: 'CAMP', desiredMoveIn: d(30), joinedAt: t(-6) },
    { id: 'demo-wl-e2', prospectName: 'Lea Vogel', prospectEmail: 'lea.vogel@uni-berlin.de', propertyCode: 'CAMP', desiredMoveIn: d(45), joinedAt: t(-3) },
    { id: 'demo-wl-e3', prospectName: 'Finn Braun', propertyCode: 'CAMP', desiredMoveIn: d(60), joinedAt: t(-1) },
  ];
  const contributions: DemoCapitalMove[] = [
    { id: 'demo-con-e1', entityCode: 'DE-SPE', amountCents: 50_000_000, recordedAt: t(-300), memo: 'Seed equity — German portfolio' },
    { id: 'demo-con-e2', entityCode: 'NL-SPE', amountCents: 20_000_000, recordedAt: t(-260), memo: 'Seed equity — Dutch portfolio' },
  ];
  const distributions: DemoCapitalMove[] = [
    { id: 'demo-dis-e1', entityCode: 'DE-SPE', propertyCode: 'BER', amountCents: 1_800_000, recordedAt: t(-20), memo: 'Q2 distribution — Berlin' },
    { id: 'demo-dis-e2', entityCode: 'DE-SPE', propertyCode: 'MUC', amountCents: 1_200_000, recordedAt: t(-20), memo: 'Q2 distribution — München' },
  ];
  const roommateProspects: DemoProspect[] = [
    { id: 'demo-rp-e1', name: 'Noah Keller', partyId: 'demo-party-stu1', preferences: { cleanliness: 4, social: 3, chronotype: 'early', smoker: false, smokeFreeOnly: true } },
    { id: 'demo-rp-e2', name: 'Mia Hofer', partyId: 'demo-party-stu2', preferences: { cleanliness: 5, social: 2, chronotype: 'early', smoker: false, smokeFreeOnly: true } },
    { id: 'demo-rp-e3', name: 'Elif Yılmaz', preferences: { cleanliness: 3, social: 4, chronotype: 'late', smoker: false } },
  ];
  const byr = at.slice(0, 4);
  const py = (code: string, rev: number, mgmt: number, rep: number, util: number): DemoPropertyBudget => ({
    id: `demo-pbud-${code}`, propertyCode: code, periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, notes: 'FY operating plan',
    lines: [
      { category: 'revenue', label: 'Rental income', amountCents: rev },
      { category: 'expense', label: 'Property management', amountCents: mgmt },
      { category: 'expense', label: 'Repairs & maintenance', amountCents: rep },
      { category: 'expense', label: 'Utilities & common area', amountCents: util },
    ],
  });
  const propertyBudgets: DemoPropertyBudget[] = [
    py('BER', 1_920_000_00, 192_000_00, 140_000_00, 96_000_00),
    py('MUC', 1_440_000_00, 144_000_00, 108_000_00, 84_000_00),
    py('AMS', 1_680_000_00, 168_000_00, 120_000_00, 90_000_00),
    py('CAMP', 960_000_00, 96_000_00, 72_000_00, 120_000_00),
  ];

  return {
    tenantId, properties, units, guests, parties, pricingRules, agreements, invoices, deposits, bills, workOrders, leads,
    legalEntities, applications, tours, insurancePolicies, utilityBills, parcels, waitlist, distributions, contributions, roommateProspects, propertyBudgets,
  };
}
