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

export interface DemoUnit { code: string; label: string; active: boolean; propertyCode?: string; typeCode?: string }
export interface DemoUnitType { code: string; name: string; bedrooms?: number; bathrooms?: number; maxGuests?: number; areaSqm?: number; baseRentCents?: number }
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
export interface DemoBudgetLine { category: 'revenue' | 'expense'; label: string; amountCents: number; account?: string }
export interface DemoPropertyBudget { id: string; propertyCode: string; periodStart: string; periodEnd: string; lines: DemoBudgetLine[]; notes?: string }
export interface DemoSpace { code: string; label: string; type: 'common' | 'amenity'; capacity?: number }
export interface DemoReservation { id: string; spaceCode: string; holderPartyId: string; start: string; end: string; reservedAt: string; priceCents?: number; note?: string }
export interface DemoThreadMessage { id: string; at: string; authorType: 'party' | 'user' | 'agent'; authorId: string; body: string }
export interface DemoThread { id: string; subject: string; kind: 'resident' | 'finance' | 'internal'; createdAt: string; agreementId?: string; partyId?: string; resolvedAt?: string; messages: DemoThreadMessage[] }
export interface DemoBankTx { id: string; postedAt: string; amountCents: number; description: string; reference?: string }
export interface DemoPurchaseOrder { id: string; vendorId: string; entityCode?: string; createdAt: string; expectedAt?: string; memo?: string; lines: { description: string; account: string; amountCents: number }[]; approve?: boolean; receive?: boolean }
export interface DemoProcBudget { id: string; account: string; periodStart: string; periodEnd: string; amountCents: number; label?: string }
export interface DemoUnitTurn { id: string; unitCode: string; vacatedAt: string; createdAt: string; notes?: string; tasksDone?: number }
export interface DemoPmSchedule { id: string; title: string; cadenceDays: number; nextDueAt: string; createdAt: string; priority?: string }
export interface DemoEnvelope { id: string; documentName: string; provider: string; createdAt: string; agreementId?: string; leadId?: string; signers: { name: string; email: string; role: string; partyId?: string }[]; send?: boolean }
export interface DemoNotification { id: string; channel: 'email' | 'sms'; to: string; kind: string; createdAt: string; data?: Record<string, unknown> }
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
  unitTypes?: DemoUnitType[];
  spaces?: DemoSpace[];
  reservations?: DemoReservation[];
  threads?: DemoThread[];
  bankTransactions?: DemoBankTx[];
  purchaseOrders?: DemoPurchaseOrder[];
  procurementBudgets?: DemoProcBudget[];
  unitTurns?: DemoUnitTurn[];
  pmSchedules?: DemoPmSchedule[];
  signatureEnvelopes?: DemoEnvelope[];
  notifications?: DemoNotification[];
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
  // Owning legal entities (an operating company + one SPE per community) so the
  // owner statements, distributions, contributions and capital-account views all
  // have a real entity to roll up to.
  const legalEntities: DemoEntity[] = [
    { code: 'OPCO', role: 'operator', name: 'Ilhabela Stays Operações Ltda', taxId: '11.111.111/0001-11' },
    { code: 'SPE-CURRAL', role: 'spe', name: 'Curral SPE Participações Ltda', taxId: '22.222.222/0001-22' },
    { code: 'SPE-VILA', role: 'spe', name: 'Vila Perequê SPE Ltda', taxId: '33.333.333/0001-33' },
  ];
  const properties: DemoProperty[] = [
    { code: 'CURRAL', name: 'Praia do Curral', address: 'Av. Force, Ilhabela', entityCode: 'SPE-CURRAL' },
    { code: 'VILA', name: 'Vila & Perequê', address: 'Perequê, Ilhabela', entityCode: 'SPE-VILA' },
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
      { category: 'revenue', label: 'Room & rent revenue', account: 'revenue:rent', amountCents: 264_000_00 },
      { category: 'expense', label: 'Property management', account: 'expense:management', amountCents: 26_400_00 },
      { category: 'expense', label: 'Repairs & maintenance', account: 'expense:maintenance', amountCents: 18_000_00 },
      { category: 'expense', label: 'Utilities', account: 'expense:utilities', amountCents: 12_000_00 } ] },
    { id: 'pbud-VILA', propertyCode: 'VILA', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, notes: 'FY operating plan', lines: [
      { category: 'revenue', label: 'Room & rent revenue', account: 'revenue:rent', amountCents: 123_000_00 },
      { category: 'expense', label: 'Property management', account: 'expense:management', amountCents: 12_300_00 },
      { category: 'expense', label: 'Repairs & maintenance', account: 'expense:maintenance', amountCents: 9_000_00 } ] },
  ];
  // --- leasing funnel: tours + applications (tie back to CRM leads) --------
  const tours: DemoTour[] = [
    { id: 'demo-tour-1', prospectName: 'Grupo corporativo — offsite', prospectEmail: 'eventos@corp.example.com', scheduledAt: t(2), leadId: 'demo-lead-2', unitCode: 'ILH-CASA', notes: 'Interessados na casa inteira para 10 pax.', createdAt: t(-1) },
    { id: 'demo-tour-2', prospectName: 'Temporada janeiro — Loft 201', scheduledAt: t(5), leadId: 'demo-lead-5', unitCode: 'ILH-LOFT1', createdAt: t(-2) },
    { id: 'demo-tour-3', prospectName: 'Casal lua de mel', prospectEmail: 'casal@example.com', scheduledAt: t(-1), leadId: 'demo-lead-3', unitCode: 'ILH-LOFT2', createdAt: t(-4) },
  ];
  const applications: DemoApplication[] = [
    { id: 'demo-app-1', applicantName: 'Casal lua de mel', applicantEmail: 'casal@example.com', leadId: 'demo-lead-3', unitCode: 'ILH-LOFT2', incomeCents: 900_000, submittedAt: t(-13) },
    { id: 'demo-app-2', applicantName: 'Locação anual — Perequê', applicantEmail: 'anual@example.com', leadId: 'demo-lead-4', unitCode: 'ILH-RES1', incomeCents: 1_500_000, submittedAt: t(-24) },
  ];

  // --- renters-insurance compliance (one active, one expiring soon) --------
  const insurancePolicies: DemoInsurance[] = [
    { id: 'demo-ins-1', agreementId: 'demo-agr-lease-1', partyId: 'demo-party-joao', carrier: 'Porto Seguro', policyNumber: 'PS-2026-0001', liabilityCents: 5_000_000, effectiveAt: d(-190), expiresAt: d(175), createdAt: t(-190) },
    { id: 'demo-ins-2', agreementId: 'demo-agr-lease-3', partyId: 'demo-party-loja', carrier: 'Bradesco Seguros', policyNumber: 'BR-2025-7788', liabilityCents: 8_000_000, effectiveAt: d(-350), expiresAt: d(20), createdAt: t(-350) },
  ];

  // --- utility billing (RUBS) — a draft master bill per community ----------
  const utilityBills: DemoUtilityBill[] = [
    { id: 'demo-util-1', propertyCode: 'VILA', utility: 'water', method: 'equal', periodStart: d(-30), periodEnd: d(0), totalCents: 90_000, createdAt: t(-2) },
    { id: 'demo-util-2', propertyCode: 'CURRAL', utility: 'electric', method: 'occupancy', periodStart: d(-30), periodEnd: d(0), totalCents: 220_000, createdAt: t(-2) },
  ];

  // --- front-desk parcel room (one fresh, one aging past a week) -----------
  const parcels: DemoParcel[] = [
    { id: 'demo-par-1', partyId: 'demo-party-carlos', carrier: 'Correios', receivedAt: t(-1), description: 'Encomenda Mercado Livre', location: 'Recepção — Prateleira A2' },
    { id: 'demo-par-2', partyId: 'demo-party-lucia', carrier: 'Jadlog', receivedAt: t(-9), description: 'Caixa grande', location: 'Sala de encomendas' },
  ];

  // --- prospect waitlist (≥3 → the demand insight fires) -------------------
  const waitlist: DemoWaitlist[] = [
    { id: 'demo-wl-1', prospectName: 'Bianca Alves', propertyCode: 'CURRAL', prospectEmail: 'bianca@example.com', desiredMoveIn: d(30), joinedAt: t(-5) },
    { id: 'demo-wl-2', prospectName: 'Diego Ferreira', propertyCode: 'VILA', joinedAt: t(-3) },
    { id: 'demo-wl-3', prospectName: 'Marina Lopes', propertyCode: 'CURRAL', desiredMoveIn: d(45), joinedAt: t(-2) },
  ];

  // --- capital in (contributions) and out (distributions) per SPE ----------
  const contributions: DemoCapitalMove[] = [
    { id: 'demo-contrib-1', entityCode: 'SPE-CURRAL', propertyCode: 'CURRAL', amountCents: 5_000_000, recordedAt: t(-180), memo: 'Capital inicial — aquisição Praia do Curral' },
    { id: 'demo-contrib-2', entityCode: 'SPE-VILA', propertyCode: 'VILA', amountCents: 3_000_000, recordedAt: t(-150), memo: 'Capital inicial — Vila & Perequê' },
  ];
  const distributions: DemoCapitalMove[] = [
    { id: 'demo-dist-1', entityCode: 'SPE-CURRAL', propertyCode: 'CURRAL', amountCents: 400_000, recordedAt: t(-30), memo: 'Distribuição trimestral aos cotistas' },
    { id: 'demo-dist-2', entityCode: 'SPE-VILA', propertyCode: 'VILA', amountCents: 250_000, recordedAt: t(-20), memo: 'Distribuição trimestral aos cotistas' },
  ];

  // --- student roommate prospects (for the shared República room) ----------
  const roommateProspects: DemoProspect[] = [
    { id: 'demo-rm-1', name: 'Tiago Martins', partyId: 'demo-party-student', preferences: { cleanliness: 4, social: 3, chronotype: 'early', smoker: false } },
    { id: 'demo-rm-2', name: 'Bruno Carvalho', preferences: { cleanliness: 4, social: 3, chronotype: 'early', smoker: false } },
    { id: 'demo-rm-3', name: 'Felipe Costa', preferences: { cleanliness: 2, social: 5, chronotype: 'late', smoker: true, smokeFreeOnly: false } },
  ];

  // --- bookable amenity spaces + reservations (common-area calendar) -------
  const spaces: DemoSpace[] = [
    { code: 'CURRAL-POOL', label: 'Praia do Curral — Piscina/Deck', type: 'amenity', capacity: 20 },
    { code: 'CURRAL-SALAO', label: 'Praia do Curral — Salão de festas', type: 'amenity', capacity: 40 },
    { code: 'VILA-CHURR', label: 'Vila & Perequê — Churrasqueira', type: 'amenity', capacity: 15 },
  ];
  const reservations: DemoReservation[] = [
    { id: 'demo-resv-1', spaceCode: 'CURRAL-SALAO', holderPartyId: 'demo-party-carlos', start: d(6), end: d(7), reservedAt: t(-1), priceCents: 30_000, note: 'Aniversário — 30 convidados' },
    { id: 'demo-resv-2', spaceCode: 'VILA-CHURR', holderPartyId: 'demo-party-lucia', start: d(3), end: d(4), reservedAt: t(-2), note: 'Confraternização' },
  ];

  // --- inbox threads (resident + internal) --------------------------------
  const threads: DemoThread[] = [
    { id: 'demo-thr-1', subject: 'Wi-Fi instável no Loft 202', kind: 'resident', createdAt: t(-3), agreementId: 'demo-agr-monthly-2', partyId: 'demo-party-lucia', messages: [
      { id: 'demo-msg-1a', at: t(-3), authorType: 'party', authorId: 'demo-party-lucia', body: 'A internet cai várias vezes ao dia. Podem verificar?' },
      { id: 'demo-msg-1b', at: t(-2), authorType: 'user', authorId: 'demo-user-desk', body: 'Abrimos um chamado com a operadora; técnico agendado para amanhã.' },
    ] },
    { id: 'demo-thr-2', subject: 'Repasse de condomínio — julho', kind: 'internal', createdAt: t(-5), messages: [
      { id: 'demo-msg-2a', at: t(-5), authorType: 'user', authorId: 'demo-user-fin', body: 'Condomínio do Loft 201 a repassar ao síndico até dia 10.' },
    ] },
  ];

  // --- bank reconciliation feed (an inflow that matches, an outflow, noise) -
  const bankTransactions: DemoBankTx[] = [
    { id: 'demo-btx-1', postedAt: t(-2), amountCents: 424_000, description: 'PIX RECEBIDO — MARIA F COSTA', reference: 'E2026...0001' },
    { id: 'demo-btx-2', postedAt: t(-5), amountCents: -120_000, description: 'PIX ENVIADO — ILHA MANUTENCAO', reference: 'E2026...0002' },
    { id: 'demo-btx-3', postedAt: t(-1), amountCents: 5_000, description: 'TARIFA BANCARIA MENSAL', reference: 'TAR-07' },
  ];

  // --- purchasing: two POs (one approved) + a maintenance budget -----------
  const purchaseOrders: DemoPurchaseOrder[] = [
    { id: 'demo-po-1', vendorId: 'demo-party-vendor', entityCode: 'OPCO', createdAt: t(-12), expectedAt: d(5), memo: 'Materiais de reforma — Apto 103', lines: [{ description: 'Tinta + revestimento', account: 'expense:maintenance', amountCents: 180_000 }], approve: true },
    { id: 'demo-po-2', vendorId: 'demo-party-vendor', entityCode: 'OPCO', createdAt: t(-3), expectedAt: d(14), memo: 'Enxoval e amenities — casas de temporada', lines: [{ description: 'Roupas de cama e banho', account: 'expense:supplies', amountCents: 95_000 }] },
  ];
  const procurementBudgets: DemoProcBudget[] = [
    { id: 'demo-pbud-mnt', account: 'expense:maintenance', periodStart: `${at.slice(0, 4)}-01-01`, periodEnd: `${Number(at.slice(0, 4)) + 1}-01-01`, amountCents: 18_000_00, label: 'Manutenção anual' },
  ];

  // --- unit turns / make-ready (one stuck past a week → the ops insight) ---
  const unitTurns: DemoUnitTurn[] = [
    { id: 'demo-turn-1', unitCode: 'ILH-102B', vacatedAt: d(-10), createdAt: t(-10), notes: 'Reforma completa antes de relistar', tasksDone: 2 },
    { id: 'demo-turn-2', unitCode: 'ILH-102', vacatedAt: d(-2), createdAt: t(-2), notes: 'Preparação padrão pós check-out' },
  ];

  // --- preventive-maintenance schedules -----------------------------------
  const pmSchedules: DemoPmSchedule[] = [
    { id: 'demo-pm-1', title: 'Manutenção de ar-condicionado (todas as unidades)', cadenceDays: 90, nextDueAt: d(12), createdAt: t(-80), priority: 'normal' },
    { id: 'demo-pm-2', title: 'Tratamento semanal da piscina — Curral', cadenceDays: 7, nextDueAt: d(2), createdAt: t(-40), priority: 'high' },
  ];

  // --- e-sign envelope (a lease out for signature) ------------------------
  const signatureEnvelopes: DemoEnvelope[] = [
    { id: 'demo-env-1', documentName: 'Contrato de locação — República Quarto A', provider: 'clicksign', agreementId: 'demo-agr-lease-2', createdAt: t(-58), send: true, signers: [
      { name: 'Tiago Martins', email: 'tiago.martins@example.com', role: 'resident', partyId: 'demo-party-student' },
      { name: 'Sônia Martins', email: 'sonia.martins@example.com', role: 'guarantor', partyId: 'demo-party-parent' },
    ] },
  ];

  // --- notification outbox (receipts + a reminder) ------------------------
  const notifications: DemoNotification[] = [
    { id: 'demo-ntf-1', channel: 'email', to: 'maria.costa@example.com', kind: 'payment_receipt', createdAt: t(-2), data: { invoiceId: 'demo-inv-1', amountCents: 424_000 } },
    { id: 'demo-ntf-2', channel: 'email', to: 'sonia.martins@example.com', kind: 'collections_reminder', createdAt: t(-1), data: { invoiceId: 'demo-inv-7', daysOverdue: 32 } },
    { id: 'demo-ntf-3', channel: 'email', to: 'joao.almeida@example.com', kind: 'collections_reminder', createdAt: t(-1), data: { invoiceId: 'demo-inv-5', daysOverdue: 20 } },
  ];

  return {
    tenantId, properties, units, guests, parties, pricingRules, agreements, invoices, deposits, bills, workOrders, leads, propertyBudgets,
    legalEntities, tours, applications, insurancePolicies, utilityBills, parcels, waitlist, contributions, distributions, roommateProspects,
    spaces, reservations, threads, bankTransactions, purchaseOrders, procurementBudgets, unitTurns, pmSchedules, signatureEnvelopes, notifications,
  };
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
      { category: 'revenue', label: 'Rental income', account: 'revenue:rent', amountCents: rev },
      { category: 'expense', label: 'Property management', account: 'expense:management', amountCents: mgmt },
      { category: 'expense', label: 'Repairs & maintenance', account: 'expense:maintenance', amountCents: rep },
      { category: 'expense', label: 'Utilities & common area', account: 'expense:utilities', amountCents: util },
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

/** Marker unit for the large institutional portfolio (distinct from the others). */
export const PORTFOLIO_MARKER_UNIT_ID = 'demo-unit-AUR-101';

/**
 * A large, institutional multi-portfolio operator ("Meridian Residential") —
 * the Greystar-scale demo. Three communities, ~200+ homes each:
 *   • Aurora Heights   — 208-unit urban high-rise, LONG-LEASE ONLY (no short stay)
 *   • Harborview       — 204-unit MF that ALSO runs short stay (nightly + monthly furnished + lease)
 *   • Metro Student Commons — 220 by-the-bed student beds (academic-year leases + roommate matching)
 * Deterministic: `at` anchors every date; names/rates are index-derived (no RNG),
 * so the world is reproducible and applies through the same balanced kernel loop.
 * Occupancy is realistic (~88–94%) so Vacancy / Make-ready / Waitlist have data too.
 */
export function buildPortfolioWorld(tenantId: string, at: string): DemoWorld {
  const now = Date.parse(at);
  const d = (o: number) => isoDate(now + o * DAY);
  const t = (o: number) => isoStamp(now + o * DAY);
  const byr = at.slice(0, 4);

  const FIRST = ['James', 'Maria', 'David', 'Sofia', 'Michael', 'Emma', 'Daniel', 'Olivia', 'Lucas', 'Ava', 'Noah', 'Isabella', 'Ethan', 'Mia', 'Liam', 'Amelia', 'Mateo', 'Chloe', 'Aiden', 'Zoe', 'Omar', 'Nadia', 'Priya', 'Kenji', 'Ling', 'Hassan', 'Fatima', 'Diego', 'Yuki', 'Ade'];
  const LAST = ['Anderson', 'Silva', 'Chen', 'Patel', 'Johnson', 'Garcia', 'Muller', 'Rossi', 'Kim', 'Nguyen', 'Okafor', 'Haddad', 'Novak', 'Costa', 'Yamamoto', 'Brown', 'Dubois', 'Ivanov', 'Santos', 'Cohen', 'Reyes', 'Fischer', 'Ali', 'Wang', 'Torres', 'Berg', 'Mbeki', 'Roy', 'Suzuki', 'Walsh'];
  const pname = (i: number) => FIRST[i % FIRST.length] + ' ' + LAST[(i * 7 + 3) % LAST.length];

  const legalEntities: DemoEntity[] = [
    { code: 'OPCO', role: 'operator', name: 'Meridian Residential Management LLC', taxId: '84-1000001' },
    { code: 'SPE-AUR', role: 'spe', name: 'Aurora Heights Owner LP', taxId: '84-1000002' },
    { code: 'SPE-HAR', role: 'spe', name: 'Harborview Residential LP', taxId: '84-1000003' },
    { code: 'SPE-STU', role: 'spe', name: 'Metro Student Housing LP', taxId: '84-1000004' },
  ];
  const properties: DemoProperty[] = [
    { code: 'AUR', name: 'Aurora Heights', address: '1200 Summit Ave, Denver CO', entityCode: 'SPE-AUR' },
    { code: 'HAR', name: 'Harborview Residences', address: '88 Marina Blvd, San Diego CA', entityCode: 'SPE-HAR' },
    { code: 'STU', name: 'Metro Student Commons', address: '400 University Way, Austin TX', entityCode: 'SPE-STU' },
  ];

  // Floorplans per community. baseRentCents is monthly (nightly plans priced per night).
  const unitTypes: DemoUnitType[] = [
    { code: 'AUR-STU', name: 'Aurora Studio', bedrooms: 0, bathrooms: 1, maxGuests: 2, areaSqm: 42, baseRentCents: 165_000 },
    { code: 'AUR-1BR', name: 'Aurora 1 Bed', bedrooms: 1, bathrooms: 1, maxGuests: 2, areaSqm: 58, baseRentCents: 210_000 },
    { code: 'AUR-2BR', name: 'Aurora 2 Bed', bedrooms: 2, bathrooms: 2, maxGuests: 4, areaSqm: 84, baseRentCents: 295_000 },
    { code: 'AUR-3BR', name: 'Aurora 3 Bed', bedrooms: 3, bathrooms: 2, maxGuests: 6, areaSqm: 110, baseRentCents: 385_000 },
    { code: 'HAR-1BR', name: 'Harborview 1 Bed', bedrooms: 1, bathrooms: 1, maxGuests: 2, areaSqm: 60, baseRentCents: 230_000 },
    { code: 'HAR-2BR', name: 'Harborview 2 Bed', bedrooms: 2, bathrooms: 2, maxGuests: 4, areaSqm: 88, baseRentCents: 320_000 },
    { code: 'HAR-STAY', name: 'Harborview Furnished Suite', bedrooms: 1, bathrooms: 1, maxGuests: 3, areaSqm: 64, baseRentCents: 24_000 },
    { code: 'STU-BED', name: 'Shared Suite Bed', bedrooms: 1, bathrooms: 1, maxGuests: 1, areaSqm: 16, baseRentCents: 115_000 },
    { code: 'STU-STUDIO', name: 'Student Studio', bedrooms: 0, bathrooms: 1, maxGuests: 1, areaSqm: 24, baseRentCents: 155_000 },
  ];
  const typeRent: Record<string, number> = Object.fromEntries(unitTypes.map((u) => [u.code, u.baseRentCents!]));

  const units: DemoUnit[] = [];
  const agreements: DemoAgreement[] = [];
  const parties: DemoParty[] = [];
  const invoices: DemoInvoice[] = [];
  const deposits: DemoDeposit[] = [];
  const leased: Array<{ code: string; agId: string; propCode: string; resId: string; kind: string; rate: number }> = [];
  const vacant: Array<{ code: string; propCode: string }> = [];
  let seq = 0; // global resident index

  function makeBuilding(prefix: string, planCodes: string[], count: number, occPct: number, mode: 'lease' | 'mixed' | 'student') {
    for (let i = 0; i < count; i++) {
      const floor = Math.floor(i / 12) + 1;
      const num = floor * 100 + (i % 12) + 1;
      const code = `${prefix}-${num}`;
      const typeCode = planCodes[i % planCodes.length]!;
      const label = `${prefix === 'STU' ? 'Metro Commons' : prefix === 'AUR' ? 'Aurora Heights' : 'Harborview'} — ${mode === 'student' ? 'Bed' : 'Apt'} ${num}`;
      units.push({ code, label, active: true, propertyCode: prefix, typeCode });
      const occupied = (i * 97 + 13) % 100 < occPct * 100;
      if (!occupied) { vacant.push({ code, propCode: prefix }); continue; }
      const rid = `demo-party-res-${seq}`;
      parties.push({ id: rid, kind: 'person', displayName: pname(seq), email: `resident${seq}@meridian.example.com`, phone: `+1 415 555-${String(1000 + (seq % 8999)).padStart(4, '0')}` });
      const baseRent = typeRent[typeCode]!;
      const rate = baseRent + ((i % 6) * 3500);
      // Tenure by building mode.
      let kind: 'nightly' | 'monthly' | 'lease' = 'lease';
      if (mode === 'mixed') { const m = i % 20; kind = m < 12 ? 'lease' : m < 17 ? 'monthly' : 'nightly'; }
      let startOff: number, endOff: number, r = rate;
      if (kind === 'nightly') { startOff = -((i % 5) + 2); endOff = (i % 4) + 3; r = Math.round(baseRent); }
      else if (kind === 'monthly') { startOff = -(10 + (i * 7) % 80); endOff = startOff + 150; }
      else { startOff = -(30 + (seq * 13) % 320); endOff = startOff + 365; }
      const agId = `agr-${code}`;
      agreements.push({ id: agId, guestCode: `RES-${seq}`, unitCode: code, kind, start: d(startOff), end: d(endOff), rateCents: r, activate: true, moveIn: true, residentPartyId: rid, payerPartyId: rid });
      leased.push({ code, agId, propCode: prefix, resId: rid, kind, rate: r });
      seq++;
    }
  }

  makeBuilding('AUR', ['AUR-STU', 'AUR-1BR', 'AUR-2BR', 'AUR-3BR'], 208, 0.90, 'lease');
  makeBuilding('HAR', ['HAR-1BR', 'HAR-2BR', 'HAR-STAY'], 204, 0.88, 'mixed');
  makeBuilding('STU', ['STU-BED', 'STU-BED', 'STU-STUDIO'], 220, 0.94, 'student');

  // Sparse but varied billing: ~1 in 7 leases carries a current invoice (paid /
  // open / overdue), so AR / delinquency / collections have a real spread
  // without exploding the ledger.
  const acctFor = (kind: string) => (kind === 'nightly' ? 'revenue:nightly' : 'revenue:rent');
  leased.forEach((l, idx) => {
    if (idx % 7 !== 0) return;
    const n = invoices.length + 1;
    const mode3 = idx % 3;
    const issued = mode3 === 2 ? t(-38) : t(-6);
    const due = mode3 === 2 ? d(-24) : d(4);
    const lines = [{ description: `Rent — ${l.code}`, account: acctFor(l.kind), amountCents: l.rate }];
    const inv: DemoInvoice = { id: `inv-${l.code}-${n}`, agreementId: l.agId, issuedAt: issued, dueAt: due, lines };
    if (mode3 === 0) { inv.payCents = l.rate; inv.payMethod = 'card'; inv.paidAt = t(-2); }
    else if (mode3 === 1 && idx % 14 === 0) { inv.payCents = Math.round(l.rate / 2); inv.payMethod = 'transfer'; inv.paidAt = t(-1); }
    invoices.push(inv);
  });
  // Security deposits on ~1 in 9 leases.
  leased.forEach((l, idx) => { if (idx % 9 === 0) deposits.push({ id: `dep-${l.code}`, agreementId: l.agId, amountCents: Math.round(l.rate * 1.5), heldAt: t(-40) }); });

  const vendor = 'demo-party-vendor';
  parties.push({ id: vendor, kind: 'organization', displayName: 'Summit Facilities Services', legalName: 'Summit Facilities Services Inc', taxId: '84-2000001', email: 'ap@summitfs.example.com', phone: '+1 415 555-0900' });

  // Pricing rule for the short-stay building.
  const pricingRules: DemoPricingRule[] = [
    { id: 'demo-price-har', name: 'Harborview — dynamic short-stay', baseCents: 24_000, minCents: 16_000, maxCents: 60_000, weekendFactorBps: 13_000, occupancyTiers: [{ minOccupancyPct: 70, factorBps: 11_500 }, { minOccupancyPct: 90, factorBps: 13_000 }], losDiscounts: [{ minNights: 7, discountBps: 1_000 }, { minNights: 28, discountBps: 2_200 }] },
  ];

  // --- CRM funnel (varied stages) -----------------------------------------
  const leads: DemoLead[] = [
    { id: 'demo-lead-1', name: 'Corporate housing — 12 furnished suites (Harborview)', source: 'referral', estValueCents: 3_400_000, createdAt: t(-3), advanceTo: ['toured'] },
    { id: 'demo-lead-2', name: '2BR waitlist — Aurora Heights', source: 'website', estValueCents: 354_000, createdAt: t(-9), advanceTo: ['toured', 'applied'] },
    { id: 'demo-lead-3', name: 'Fall semester block — 20 beds (Metro Commons)', source: 'ils', estValueCents: 2_760_000, createdAt: t(-14), advanceTo: ['toured', 'applied', 'approved'] },
    { id: 'demo-lead-4', name: 'Relocation — 1BR Aurora', source: 'instagram', estValueCents: 252_000, createdAt: t(-20), advanceTo: ['toured', 'applied', 'approved', 'signed'] },
    { id: 'demo-lead-5', name: 'Group booking — cancelled', source: 'booking', estValueCents: 480_000, createdAt: t(-18), advanceTo: ['toured', 'lost'] },
    { id: 'demo-lead-6', name: 'Studio inquiry — Aurora', source: 'website', estValueCents: 165_000, createdAt: t(-1) },
  ];

  // --- leasing funnel referencing real vacant units -----------------------
  const vac = (i: number) => vacant[i % vacant.length]?.code;
  const applications: DemoApplication[] = [
    { id: 'demo-app-1', applicantName: 'Rebecca Lin', applicantEmail: 'rebecca.lin@example.com', leadId: 'demo-lead-2', unitCode: vac(0), incomeCents: 9_600_000, submittedAt: t(-8) },
    { id: 'demo-app-2', applicantName: 'Marcus Webb', applicantEmail: 'marcus.webb@example.com', leadId: 'demo-lead-3', unitCode: vac(3), incomeCents: 7_200_000, submittedAt: t(-11) },
    { id: 'demo-app-3', applicantName: 'Priya Raman', applicantEmail: 'priya.raman@example.com', unitCode: vac(6), incomeCents: 8_400_000, submittedAt: t(-4) },
    { id: 'demo-app-4', applicantName: 'Tomás Alvarez', applicantEmail: 'tomas.alvarez@example.com', unitCode: vac(9), incomeCents: 6_600_000, submittedAt: t(-2) },
  ];
  const tours: DemoTour[] = [
    { id: 'demo-tour-1', prospectName: 'Corporate housing group', prospectEmail: 'reloc@corp.example.com', scheduledAt: t(2), leadId: 'demo-lead-1', unitCode: vac(1), createdAt: t(-1) },
    { id: 'demo-tour-2', prospectName: 'Fall block coordinator', scheduledAt: t(4), leadId: 'demo-lead-3', unitCode: vac(4), createdAt: t(-2) },
    { id: 'demo-tour-3', prospectName: 'Rebecca Lin', prospectEmail: 'rebecca.lin@example.com', scheduledAt: t(-1), leadId: 'demo-lead-2', unitCode: vac(0), createdAt: t(-5) },
    { id: 'demo-tour-4', prospectName: 'Walk-in — studio', scheduledAt: t(1), unitCode: vac(7), createdAt: t(0) },
  ];
  const waitlist: DemoWaitlist[] = [
    { id: 'demo-wl-1', prospectName: 'Grace Okoye', propertyCode: 'AUR', prospectEmail: 'grace.o@example.com', desiredMoveIn: d(30), joinedAt: t(-7) },
    { id: 'demo-wl-2', prospectName: 'Ben Carter', propertyCode: 'AUR', joinedAt: t(-6) },
    { id: 'demo-wl-3', prospectName: 'Sana Iqbal', propertyCode: 'AUR', desiredMoveIn: d(45), joinedAt: t(-4) },
    { id: 'demo-wl-4', prospectName: 'Diego Ramos', propertyCode: 'HAR', joinedAt: t(-5) },
    { id: 'demo-wl-5', prospectName: 'Emily Zhang', propertyCode: 'HAR', desiredMoveIn: d(20), joinedAt: t(-3) },
    { id: 'demo-wl-6', prospectName: 'Kofi Mensah', propertyCode: 'STU', joinedAt: t(-2) },
  ];

  // --- insurance compliance (sample across leases; some expiring/lapsed) ---
  const insurancePolicies: DemoInsurance[] = leased.filter((_, i) => i % 23 === 0).slice(0, 18).map((l, i) => ({
    id: `demo-ins-${i + 1}`, agreementId: l.agId, partyId: l.resId, carrier: ['Lemonade', 'State Farm', 'Assurant', 'Allstate'][i % 4]!, policyNumber: `POL-${byr}-${1000 + i}`,
    liabilityCents: 10_000_000, effectiveAt: d(-300 + (i % 3) * 40), expiresAt: i % 5 === 0 ? d(18) : d(120 + (i % 4) * 30), createdAt: t(-300),
  }));

  // --- front-desk parcels (some aging past a week) ------------------------
  const parcels: DemoParcel[] = leased.filter((_, i) => i % 31 === 0).slice(0, 14).map((l, i) => ({
    id: `demo-par-${i + 1}`, partyId: l.resId, carrier: ['UPS', 'FedEx', 'USPS', 'Amazon'][i % 4]!, receivedAt: t(-(i % 11)), description: ['Small box', 'Envelope', 'Large parcel', 'Two boxes'][i % 4], location: `Mailroom — Shelf ${String.fromCharCode(65 + (i % 6))}${(i % 4) + 1}`,
  }));

  // --- utility billing (RUBS) per community -------------------------------
  const utilityBills: DemoUtilityBill[] = [
    { id: 'demo-util-1', propertyCode: 'AUR', utility: 'water', method: 'occupancy', periodStart: d(-30), periodEnd: d(0), totalCents: 1_840_000, createdAt: t(-2) },
    { id: 'demo-util-2', propertyCode: 'HAR', utility: 'electric', method: 'area', periodStart: d(-30), periodEnd: d(0), totalCents: 2_260_000, createdAt: t(-2) },
    { id: 'demo-util-3', propertyCode: 'STU', utility: 'trash', method: 'equal', periodStart: d(-30), periodEnd: d(0), totalCents: 640_000, createdAt: t(-2) },
  ];

  // --- vendor bills (AP) --------------------------------------------------
  const bills: DemoBill[] = [
    { id: 'demo-bill-1', payeeId: vendor, propertyCode: 'AUR', issuedAt: t(-15), dueAt: d(-2), memo: 'HVAC quarterly service — Aurora', lines: [{ description: 'Labor + parts', account: 'expense:maintenance', amountCents: 1_240_000 }], payCents: 1_240_000, payMethod: 'transfer', paidAt: t(-5) },
    { id: 'demo-bill-2', payeeId: vendor, propertyCode: 'HAR', issuedAt: t(-9), dueAt: d(6), memo: 'Landscaping — Harborview', lines: [{ description: 'Grounds maintenance', account: 'expense:maintenance', amountCents: 480_000 }] },
    { id: 'demo-bill-3', payeeId: vendor, propertyCode: 'STU', issuedAt: t(-35), dueAt: d(-14), memo: 'Common-area cleaning — Metro Commons', lines: [{ description: 'Janitorial (monthly)', account: 'expense:management', amountCents: 720_000 }] },
    { id: 'demo-bill-4', payeeId: vendor, propertyCode: 'AUR', issuedAt: t(-4), dueAt: d(11), memo: 'Elevator inspection — Aurora', lines: [{ description: 'Annual inspection', account: 'expense:maintenance', amountCents: 320_000 }] },
  ];

  // --- work orders (open/in-progress/completed across communities) --------
  const workOrders: DemoWorkOrder[] = [
    { id: 'demo-wo-1', title: 'AC not cooling — Aurora Apt 512', category: 'hvac', priority: 'high', openedAt: t(-1), requestedByPartyId: leased[10]?.resId, assignVendorPartyId: vendor, startedAt: t(-1) },
    { id: 'demo-wo-2', title: 'Leak under sink — Harborview Apt 305', category: 'plumbing', priority: 'urgent', openedAt: t(-4), requestedByPartyId: leased[220]?.resId, assignVendorPartyId: vendor, startedAt: t(-3), completedAt: t(-2), resolution: 'Replaced P-trap.' },
    { id: 'demo-wo-3', title: 'Garage gate sticking — Aurora', category: 'general', priority: 'normal', openedAt: t(-2), assignVendorPartyId: vendor },
    { id: 'demo-wo-4', title: 'Common-area lighting — Metro Commons', category: 'electrical', priority: 'normal', openedAt: t(-6), requestedByPartyId: leased[420]?.resId },
    { id: 'demo-wo-5', title: 'Pest control — Harborview 3rd floor', category: 'general', priority: 'low', openedAt: t(-8), assignVendorPartyId: vendor, startedAt: t(-7), completedAt: t(-6), resolution: 'Treated; follow-up in 30d.' },
  ];

  // --- unit turns on vacant units (one stuck past a week) -----------------
  const unitTurns: DemoUnitTurn[] = vacant.slice(0, 6).map((v, i) => ({ id: `demo-turn-${i + 1}`, unitCode: v.code, vacatedAt: d(-(i === 0 ? 12 : (i * 2) + 1)), createdAt: t(-(i === 0 ? 12 : (i * 2) + 1)), notes: i % 2 ? 'Standard turn' : 'Full make-ready (paint + flooring)', tasksDone: i % 5 }));

  // --- preventive maintenance ---------------------------------------------
  const pmSchedules: DemoPmSchedule[] = [
    { id: 'demo-pm-1', title: 'HVAC filter change — Aurora (all floors)', cadenceDays: 90, nextDueAt: d(12), createdAt: t(-80), priority: 'normal' },
    { id: 'demo-pm-2', title: 'Fire-alarm test — Harborview', cadenceDays: 180, nextDueAt: d(5), createdAt: t(-120), priority: 'high' },
    { id: 'demo-pm-3', title: 'Elevator service — Aurora', cadenceDays: 30, nextDueAt: d(-1), createdAt: t(-60), priority: 'high' },
    { id: 'demo-pm-4', title: 'Pool chemical check — Harborview', cadenceDays: 7, nextDueAt: d(2), createdAt: t(-40), priority: 'normal' },
  ];

  // --- amenity spaces + reservations --------------------------------------
  const spaces: DemoSpace[] = [
    { code: 'AUR-LOUNGE', label: 'Aurora — Sky Lounge', type: 'amenity', capacity: 40 },
    { code: 'AUR-GYM', label: 'Aurora — Fitness Center', type: 'amenity', capacity: 25 },
    { code: 'HAR-BBQ', label: 'Harborview — Rooftop BBQ', type: 'amenity', capacity: 20 },
    { code: 'STU-STUDY', label: 'Metro Commons — Study Rooms', type: 'amenity', capacity: 12 },
  ];
  const reservations: DemoReservation[] = [
    { id: 'demo-resv-1', spaceCode: 'AUR-LOUNGE', holderPartyId: leased[5]?.resId ?? vendor, start: d(6), end: d(7), reservedAt: t(-1), priceCents: 15_000, note: 'Resident birthday — 25 guests' },
    { id: 'demo-resv-2', spaceCode: 'HAR-BBQ', holderPartyId: leased[210]?.resId ?? vendor, start: d(3), end: d(4), reservedAt: t(-2), note: 'Floor social' },
    { id: 'demo-resv-3', spaceCode: 'STU-STUDY', holderPartyId: leased[410]?.resId ?? vendor, start: d(1), end: d(2), reservedAt: t(0), note: 'Study group' },
  ];

  // --- inbox threads ------------------------------------------------------
  const threads: DemoThread[] = [
    { id: 'demo-thr-1', subject: 'Package not received — Aurora 512', kind: 'resident', createdAt: t(-3), partyId: leased[10]?.resId, messages: [
      { id: 'demo-msg-1a', at: t(-3), authorType: 'party', authorId: leased[10]?.resId ?? 'x', body: 'Tracking says delivered but nothing in the mailroom.' },
      { id: 'demo-msg-1b', at: t(-2), authorType: 'user', authorId: 'demo-user-desk', body: 'Found it behind the desk — logged under your name, ready for pickup.' },
    ] },
    { id: 'demo-thr-2', subject: 'Q3 owner distribution timing', kind: 'finance', createdAt: t(-5), messages: [
      { id: 'demo-msg-2a', at: t(-5), authorType: 'user', authorId: 'demo-user-fin', body: 'Aurora Q3 distribution to the LP scheduled after the close.' },
    ] },
    { id: 'demo-thr-3', subject: 'Fire-alarm test scheduling — Harborview', kind: 'internal', createdAt: t(-6), messages: [
      { id: 'demo-msg-3a', at: t(-6), authorType: 'user', authorId: 'demo-user-ops', body: 'Vendor confirmed for the 5th; notify residents 48h prior.' },
    ] },
  ];

  // --- bank reconciliation feed -------------------------------------------
  const bankTransactions: DemoBankTx[] = [
    { id: 'demo-btx-1', postedAt: t(-2), amountCents: 210_000, description: 'ACH CREDIT — RESIDENT RENT', reference: 'ACH-0001' },
    { id: 'demo-btx-2', postedAt: t(-2), amountCents: 295_000, description: 'ACH CREDIT — RESIDENT RENT', reference: 'ACH-0002' },
    { id: 'demo-btx-3', postedAt: t(-5), amountCents: -1_240_000, description: 'WIRE — SUMMIT FACILITIES', reference: 'WIRE-0007' },
    { id: 'demo-btx-4', postedAt: t(-1), amountCents: -18_500, description: 'BANK SERVICE FEE', reference: 'FEE-07' },
    { id: 'demo-btx-5', postedAt: t(-3), amountCents: 165_000, description: 'CARD DEPOSIT — SHORT STAY', reference: 'CARD-0044' },
  ];

  // --- purchasing: POs (one approved) + budgets ---------------------------
  const purchaseOrders: DemoPurchaseOrder[] = [
    { id: 'demo-po-1', vendorId: vendor, entityCode: 'OPCO', createdAt: t(-12), expectedAt: d(5), memo: 'Unit-turn materials — Aurora', lines: [{ description: 'Paint + flooring (10 units)', account: 'expense:maintenance', amountCents: 2_400_000 }], approve: true },
    { id: 'demo-po-2', vendorId: vendor, entityCode: 'OPCO', createdAt: t(-3), expectedAt: d(14), memo: 'Furnished-suite linens — Harborview', lines: [{ description: 'Linens & amenities', account: 'expense:supplies', amountCents: 680_000 }] },
    { id: 'demo-po-3', vendorId: vendor, entityCode: 'OPCO', createdAt: t(-1), expectedAt: d(21), memo: 'Study-room furniture — Metro Commons', lines: [{ description: 'Desks & chairs', account: 'expense:supplies', amountCents: 940_000 }] },
  ];
  const procurementBudgets: DemoProcBudget[] = [
    { id: 'demo-pbud-mnt', account: 'expense:maintenance', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, amountCents: 96_000_00, label: 'Annual R&M' },
    { id: 'demo-pbud-sup', account: 'expense:supplies', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, amountCents: 24_000_00, label: 'Annual supplies' },
  ];

  // --- e-sign envelope out for signature ----------------------------------
  const signatureEnvelopes: DemoEnvelope[] = leased[3] ? [
    { id: 'demo-env-1', documentName: `Lease — ${leased[3].code}`, provider: 'docusign', agreementId: leased[3].agId, createdAt: t(-6), send: true, signers: [{ name: pname(3), email: 'resident3@meridian.example.com', role: 'resident', partyId: leased[3].resId }] },
  ] : [];

  // --- property budgets (per community) -----------------------------------
  const propertyBudgets: DemoPropertyBudget[] = [
    { id: 'pbud-AUR', propertyCode: 'AUR', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, notes: 'FY operating plan', lines: [
      { category: 'revenue', label: 'Rental revenue', account: 'revenue:rent', amountCents: 5_400_000_00 },
      { category: 'expense', label: 'Property management', account: 'expense:management', amountCents: 540_000_00 },
      { category: 'expense', label: 'Repairs & maintenance', account: 'expense:maintenance', amountCents: 420_000_00 },
      { category: 'expense', label: 'Utilities', account: 'expense:utilities', amountCents: 300_000_00 } ] },
    { id: 'pbud-HAR', propertyCode: 'HAR', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, notes: 'FY operating plan', lines: [
      { category: 'revenue', label: 'Rental + short-stay revenue', account: 'revenue:rent', amountCents: 5_900_000_00 },
      { category: 'expense', label: 'Property management', account: 'expense:management', amountCents: 590_000_00 },
      { category: 'expense', label: 'Repairs & maintenance', account: 'expense:maintenance', amountCents: 460_000_00 } ] },
    { id: 'pbud-STU', propertyCode: 'STU', periodStart: `${byr}-01-01`, periodEnd: `${Number(byr) + 1}-01-01`, notes: 'FY operating plan', lines: [
      { category: 'revenue', label: 'Bed revenue', account: 'revenue:rent', amountCents: 3_000_000_00 },
      { category: 'expense', label: 'Property management', account: 'expense:management', amountCents: 360_000_00 } ] },
  ];

  // --- owner capital in/out per SPE ---------------------------------------
  const contributions: DemoCapitalMove[] = [
    { id: 'demo-contrib-1', entityCode: 'SPE-AUR', propertyCode: 'AUR', amountCents: 480_000_00, recordedAt: t(-320), memo: 'Acquisition equity — Aurora Heights' },
    { id: 'demo-contrib-2', entityCode: 'SPE-HAR', propertyCode: 'HAR', amountCents: 520_000_00, recordedAt: t(-300), memo: 'Acquisition equity — Harborview' },
    { id: 'demo-contrib-3', entityCode: 'SPE-STU', propertyCode: 'STU', amountCents: 260_000_00, recordedAt: t(-280), memo: 'Acquisition equity — Metro Commons' },
  ];
  const distributions: DemoCapitalMove[] = [
    { id: 'demo-dist-1', entityCode: 'SPE-AUR', propertyCode: 'AUR', amountCents: 42_000_00, recordedAt: t(-30), memo: 'Q2 distribution to LP' },
    { id: 'demo-dist-2', entityCode: 'SPE-HAR', propertyCode: 'HAR', amountCents: 38_000_00, recordedAt: t(-28), memo: 'Q2 distribution to LP' },
  ];

  // --- roommate prospects for the student community -----------------------
  const roommateProspects: DemoProspect[] = [
    { id: 'demo-rm-1', name: 'Alex Rivera', preferences: { cleanliness: 4, social: 3, chronotype: 'early', smoker: false } },
    { id: 'demo-rm-2', name: 'Jordan Kim', preferences: { cleanliness: 4, social: 4, chronotype: 'early', smoker: false } },
    { id: 'demo-rm-3', name: 'Sam Patel', preferences: { cleanliness: 2, social: 5, chronotype: 'late', smoker: true, smokeFreeOnly: false } },
    { id: 'demo-rm-4', name: 'Riley Chen', preferences: { cleanliness: 5, social: 2, chronotype: 'early', smoker: false, smokeFreeOnly: true } },
  ];

  // --- notification outbox ------------------------------------------------
  const notifications: DemoNotification[] = [
    { id: 'demo-ntf-1', channel: 'email', to: 'resident0@meridian.example.com', kind: 'payment_receipt', createdAt: t(-2), data: { amountCents: 210_000 } },
    { id: 'demo-ntf-2', channel: 'email', to: 'resident7@meridian.example.com', kind: 'collections_reminder', createdAt: t(-1), data: { daysOverdue: 24 } },
    { id: 'demo-ntf-3', channel: 'email', to: 'resident14@meridian.example.com', kind: 'collections_reminder', createdAt: t(-1), data: { daysOverdue: 24 } },
    { id: 'demo-ntf-4', channel: 'email', to: 'resident3@meridian.example.com', kind: 'esign_request', createdAt: t(-6), data: { document: 'Lease' } },
  ];

  return {
    tenantId, properties, units, guests: [], parties, pricingRules, agreements, invoices, deposits, bills, workOrders, leads,
    legalEntities, applications, tours, insurancePolicies, utilityBills, parcels, waitlist, distributions, contributions, roommateProspects, propertyBudgets,
    unitTypes, spaces, reservations, threads, bankTransactions, purchaseOrders, procurementBudgets, unitTurns, pmSchedules, signatureEnvelopes, notifications,
  };
}
