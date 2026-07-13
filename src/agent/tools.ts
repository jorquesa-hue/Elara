// Agent tool layer. Exposes the kernel's operations to an LLM as tool
// definitions and routes every invocation through App.dispatch — so an agent
// tool-call still passes PolicyEnvelope.decide() before execution (invariant 2)
// and consumes the same authenticated Public API as portal and website
// (invariant 3). No bypass path exists: the catalog cannot reach the kernel
// except through dispatch.
//
// The specs are Anthropic tool-use compatible ({ name, description,
// input_schema, strict }), so `catalog.specs()` drops straight into the
// Anthropic SDK's `tools` parameter. This module stays provider-agnostic — it
// builds definitions and dispatches results; it never calls an LLM API itself
// (no provider credentials in the kernel — behavioral guardrail). See
// docs §15 for the SDK wiring sketch.

import type { App, ApiRequest } from '../api/app.ts';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties: false;
}

/** Anthropic tool-use compatible tool definition. */
export interface ToolSpec {
  name: string;
  description: string;
  input_schema: JsonSchema;
  strict: true;
}

export interface ToolResult {
  /** JSON string suitable for a tool_result content block. */
  content: string;
  /** Maps to tool_result.is_error — true when the API returned a 4xx/5xx. */
  isError: boolean;
  status: number;
}

interface ToolDef {
  spec: ToolSpec;
  /** Translate validated tool input into an ApiRequest (sans bearer). */
  toRequest: (input: Record<string, unknown>) => Omit<ApiRequest, 'bearer'>;
}

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });

function schema(properties: Record<string, unknown>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

const TOOLS: ToolDef[] = [
  {
    spec: {
      name: 'book_stay',
      description:
        'Draft a stay agreement and hold the unit on the calendar. Call this when a guest wants to book a unit for a date range. The stay starts in `draft`; call activate_agreement next to make it active. Fails if the unit is already held for any overlapping night.',
      input_schema: schema(
        {
          id: str('Client-chosen unique agreement id.'),
          guestId: str('Guest id.'),
          unitId: str('Unit id to book (must belong to your tenant).'),
          kind: { type: 'string', enum: ['nightly', 'monthly', 'lease'], description: 'Initial tenure.' },
          start: str('Check-in date, inclusive, YYYY-MM-DD.'),
          end: str('Check-out date, exclusive, YYYY-MM-DD.'),
          rateCents: int('Rate in integer cents (per night for nightly, per month otherwise).'),
        },
        ['id', 'guestId', 'unitId', 'kind', 'start', 'end', 'rateCents'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/agreements', body: i }),
  },
  {
    spec: {
      name: 'activate_agreement',
      description: 'Activate a drafted agreement so it can be billed and converted. Call this after book_stay.',
      input_schema: schema({ id: str('Agreement id to activate.') }, ['id']),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: `/agreements/${i['id']}/activate`, body: {} }),
  },
  {
    spec: {
      name: 'convert_agreement',
      description:
        'Convert an active agreement forward along nightly → monthly → lease, preserving its id and ledger. Call this when a guest extends a nightly stay into a monthly one, or a monthly into a lease. Conversion only moves forward; a lease is regulated and its execution escalates to a human.',
      input_schema: schema(
        {
          id: str('Agreement id to convert.'),
          to: { type: 'string', enum: ['monthly', 'lease'], description: 'Target tenure (must be forward of current).' },
          rateCents: int('New rate in integer cents.'),
          end: str('New end date, exclusive, YYYY-MM-DD.'),
        },
        ['id', 'to'],
      ),
      strict: true,
    },
    toRequest: (i) => {
      const { id, ...body } = i;
      return { method: 'POST', path: `/agreements/${id}/convert`, body };
    },
  },
  {
    spec: {
      name: 'get_agreement',
      description: 'Fetch an agreement’s current kind, status, rate, period, and full event history. Read-only.',
      input_schema: schema({ id: str('Agreement id.') }, ['id']),
      strict: true,
    },
    toRequest: (i) => ({ method: 'GET', path: `/agreements/${i['id']}` }),
  },
  {
    spec: {
      name: 'issue_invoice',
      description:
        'Issue an invoice against an agreement and post the receivable to the ledger. Each line names a revenue account and an integer-cent amount. Use for room charges, amenities, and fees.',
      input_schema: schema(
        {
          id: str('Client-chosen unique invoice id.'),
          agreementId: str('Agreement to bill.'),
          dueAt: str('Due date/time, ISO-8601.'),
          lines: {
            type: 'array',
            description: 'One or more invoice lines.',
            items: schema(
              {
                description: str('Line description.'),
                account: str('Revenue account, e.g. revenue:room or revenue:amenity.'),
                amountCents: int('Positive integer cents.'),
              },
              ['description', 'account', 'amountCents'],
            ),
          },
        },
        ['id', 'agreementId', 'dueAt', 'lines'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/invoices', body: i }),
  },
  {
    spec: {
      name: 'record_payment',
      description:
        'Record a settled payment against an invoice and move cash on the ledger. Call this only for payments a provider has ALREADY settled — this system never charges cards itself. Refuses to overpay an invoice.',
      input_schema: schema(
        {
          id: str('Client-chosen unique payment id.'),
          invoiceId: str('Invoice being paid.'),
          amountCents: int('Amount settled, positive integer cents; must not exceed the invoice remainder.'),
          method: { type: 'string', enum: ['pix', 'card', 'transfer', 'cash'], description: 'Settlement method.' },
        },
        ['id', 'invoiceId', 'amountCents', 'method'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/payments', body: i }),
  },
  {
    spec: {
      name: 'hold_deposit',
      description: 'Take a security deposit and hold it as a liability. Refund it later with refund_deposit.',
      input_schema: schema(
        {
          id: str('Client-chosen unique deposit id.'),
          agreementId: str('Agreement the deposit secures.'),
          amountCents: int('Deposit amount, positive integer cents.'),
        },
        ['id', 'agreementId', 'amountCents'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/deposits', body: i }),
  },
  {
    spec: {
      name: 'refund_deposit',
      description:
        'Refund a held deposit, net of itemized deductions. Deductions become revenue; the remainder is returned as cash. Deductions may not exceed the held amount.',
      input_schema: schema(
        {
          id: str('Deposit id to refund.'),
          deductions: {
            type: 'array',
            description: 'Itemized deductions (may be empty for a full refund).',
            items: schema(
              { reason: str('Why deducted.'), amountCents: int('Deducted amount, positive integer cents.') },
              ['reason', 'amountCents'],
            ),
          },
        },
        ['id'],
      ),
      strict: true,
    },
    toRequest: (i) => {
      const { id, ...body } = i;
      return { method: 'POST', path: `/deposits/${id}/refund`, body };
    },
  },
  {
    spec: {
      name: 'get_trial_balance',
      description:
        'Return the tenant-scoped trial balance: net debits/credits per account, plus whether the ledger balances. Read-only. Use to check the books before or after a batch of postings.',
      input_schema: schema({}, []),
      strict: true,
    },
    toRequest: () => ({ method: 'GET', path: '/ledger/trial-balance' }),
  },
  {
    spec: {
      name: 'list_exceptions',
      description:
        'List the pending escalations awaiting a human decision (e.g. lease execution, large refunds, eviction). Read-only. An agent CANNOT approve these — surface them to a human.',
      input_schema: schema({}, []),
      strict: true,
    },
    toRequest: () => ({ method: 'GET', path: '/exceptions' }),
  },
  {
    spec: {
      name: 'approve_exception',
      description:
        'Approve a pending escalation and run its deferred operation. Requires a staff or service role — an agent bearer is refused with 403. Use only when a human has authorized the action.',
      input_schema: schema(
        { id: str('Exception id to approve.'), note: str('Optional approval note.') },
        ['id'],
      ),
      strict: true,
    },
    toRequest: (i) => {
      const { id, ...body } = i;
      return { method: 'POST', path: `/exceptions/${id}/approve`, body };
    },
  },
  {
    spec: {
      name: 'get_subscription',
      description:
        'Return the per-unit SaaS subscription charge for your tenant (managed unit count × per-unit rate). Read-only. This is the platform’s bill to the operator, not a guest charge.',
      input_schema: schema({}, []),
      strict: true,
    },
    toRequest: () => ({ method: 'GET', path: '/billing/subscription' }),
  },
  // --- country environment ------------------------------------------------
  {
    spec: {
      name: 'get_environment',
      description:
        'Return this tenant’s country environment: country, jurisdiction, currency/locale/timezone, the effective jurisdiction-scoped policy, and the (identical-for-every-country) master-data structure. Read-only. Use to understand which rules apply before acting.',
      input_schema: schema({}, []),
      strict: true,
    },
    toRequest: () => ({ method: 'GET', path: '/environment' }),
  },
  // --- dynamic pricing ----------------------------------------------------
  {
    spec: {
      name: 'quote_stay',
      description:
        'Quote a nightly + total price for a stay from a pricing rule, with an explainable factor breakdown (occupancy, weekend, lead-time, season, length-of-stay). Read-only — this computes a price, it does not book. Supply the demand signal via occupancyPct.',
      input_schema: schema(
        {
          ruleId: str('Pricing rule id to quote against.'),
          checkIn: str('Check-in date, YYYY-MM-DD.'),
          nights: int('Number of nights, positive integer.'),
          occupancyPct: int('Current occupancy 0..100 — the demand signal (optional).'),
        },
        ['ruleId', 'checkIn', 'nights'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/pricing/quote', body: i }),
  },
  // --- people on an agreement + lease changes -----------------------------
  {
    spec: {
      name: 'assign_party',
      description:
        'Assign a party to an agreement in a role (resident, financial_responsible, guarantor, cosigner, occupant, payee). The financial_responsible/payee is who gets billed — use this to model parents-pay-for-student.',
      input_schema: schema(
        {
          agreementId: str('Agreement to assign to.'),
          partyId: str('Party id (must exist in your tenant).'),
          role: { type: 'string', enum: ['resident', 'financial_responsible', 'guarantor', 'cosigner', 'occupant', 'prospect', 'payee'], description: 'The party’s role on this agreement.' },
        },
        ['agreementId', 'partyId', 'role'],
      ),
      strict: true,
    },
    toRequest: (i) => {
      const { agreementId, ...body } = i;
      return { method: 'POST', path: `/agreements/${agreementId}/parties`, body };
    },
  },
  {
    spec: {
      name: 'adjust_rent',
      description:
        'Apply a scheduled rent adjustment to an agreement (percent or fixed increase, respecting any cap). Routine and fully audited. Large or out-of-terms adjustments may escalate to a human.',
      input_schema: schema(
        {
          id: str('Agreement id.'),
          basis: { type: 'string', enum: ['percent', 'fixed'], description: 'Adjust by a percentage or a fixed cents amount.' },
          value: int('Percentage points (basis=percent) or cents (basis=fixed).'),
          reason: str('Why the rent is changing (e.g. annual index).'),
        },
        ['id', 'basis', 'value', 'reason'],
      ),
      strict: true,
    },
    toRequest: (i) => {
      const { id, ...body } = i;
      return { method: 'POST', path: `/agreements/${id}/adjust-rent`, body };
    },
  },
  {
    spec: {
      name: 'transfer_unit',
      description:
        'Transfer an agreement to a different unit, preserving its id and ledger and swapping the calendar hold. Fails if the target unit is held for any overlapping night.',
      input_schema: schema({ id: str('Agreement id.'), toUnitId: str('Destination unit id.'), reason: str('Why transferring.') }, ['id', 'toUnitId', 'reason']),
      strict: true,
    },
    toRequest: (i) => {
      const { id, ...body } = i;
      return { method: 'POST', path: `/agreements/${id}/transfer`, body };
    },
  },
  {
    spec: {
      name: 'record_move',
      description:
        'Record a move-in or move-out on an active agreement. Pair with an inspection (vistoria) around each move; a move-out damage estimate informs the deposit refund.',
      input_schema: schema({ id: str('Agreement id.'), direction: { type: 'string', enum: ['move-in', 'move-out'], description: 'Which move to record.' } }, ['id', 'direction']),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: `/agreements/${i['id']}/${i['direction']}`, body: {} }),
  },
  // --- leasing pipeline (CRM) ---------------------------------------------
  {
    spec: {
      name: 'create_lead',
      description: 'Add a lead to the leasing pipeline (stage new). Optionally link a party and an estimated monthly/lease value that powers pipeline KPIs.',
      input_schema: schema(
        { id: str('Client-chosen lead id.'), name: str('Lead name.'), source: str('Where it came from (website, referral…). Optional.'), estValueCents: int('Estimated value in cents. Optional.'), partyId: str('Linked party id. Optional.') },
        ['id', 'name'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/leads', body: i }),
  },
  {
    spec: {
      name: 'advance_lead',
      description: 'Move a lead forward in the funnel: new → toured → applied → approved → signed. Forward-only. Reaching "signed" records the sales outcome; the binding lease still executes through the human-gated path.',
      input_schema: schema({ id: str('Lead id.'), stage: { type: 'string', enum: ['toured', 'applied', 'approved', 'signed'], description: 'Target stage (must be forward of current).' } }, ['id', 'stage']),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: `/leads/${i['id']}/advance`, body: { stage: i['stage'] } }),
  },
  {
    spec: {
      name: 'lose_lead',
      description: 'Drop a lead from the pipeline with a reason. Closed — it cannot be advanced afterward.',
      input_schema: schema({ id: str('Lead id.'), reason: str('Why lost (budget, chose elsewhere…).') }, ['id', 'reason']),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: `/leads/${i['id']}/lose`, body: { reason: i['reason'] } }),
  },
  {
    spec: {
      name: 'get_pipeline',
      description: 'Return the leasing funnel KPIs: counts by stage, open/won/lost, open pipeline value, won value, and conversion rate. Read-only.',
      input_schema: schema({}, []),
      strict: true,
    },
    toRequest: () => ({ method: 'GET', path: '/crm/summary' }),
  },
  // --- e-signature (does NOT execute the lease) ---------------------------
  {
    spec: {
      name: 'prepare_signature',
      description:
        'Prepare a lease document for e-signature with a signer roster (resident, optional guarantor). This does NOT execute the lease — a fully signed envelope advances the linked lead, but binding lease execution stays a separate human-confirmed step. Call send_signature to dispatch it.',
      input_schema: schema(
        {
          id: str('Client-chosen envelope id.'),
          documentName: str('Document name, e.g. "Lease — Unit 101".'),
          provider: str('E-sign provider, e.g. docusign, clicksign.'),
          leadId: str('CRM lead this closes. Optional.'),
          agreementId: str('Agreement this will bind. Optional.'),
          signers: {
            type: 'array',
            description: 'One or more signers.',
            items: schema({ name: str('Signer name.'), email: str('Signer email.'), role: str('resident, guarantor, cosigner…') }, ['name', 'email', 'role']),
          },
        },
        ['id', 'documentName', 'provider', 'signers'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/signature-envelopes', body: i }),
  },
  {
    spec: {
      name: 'send_signature',
      description: 'Send a prepared envelope out for signature via the provider (credentials live in the secret store; none pass through here). Audited.',
      input_schema: schema({ id: str('Envelope id to send.') }, ['id']),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: `/signature-envelopes/${i['id']}/send`, body: {} }),
  },
  {
    spec: {
      name: 'draft_lease_envelope',
      description:
        'Generate the lease document from an agreement\'s deal terms (jurisdiction-aware) and open a draft e-sign envelope, auto-rostering signers from the agreement\'s party links that carry an email (resident, guarantor, cosigner). Call send_signature to dispatch it. Does NOT execute the lease.',
      input_schema: schema(
        { agreementId: str('Agreement to draft the lease for.'), provider: str('E-sign provider, e.g. docusign. Optional (defaults docusign).'), id: str('Client-chosen envelope id. Optional.') },
        ['agreementId'],
      ),
      strict: true,
    },
    toRequest: (i) => {
      const { agreementId, ...body } = i as { agreementId: string };
      return { method: 'POST', path: `/agreements/${agreementId}/lease-envelope`, body };
    },
  },
  // --- maintenance / reservations / comms ---------------------------------
  {
    spec: {
      name: 'raise_work_order',
      description: 'Raise a maintenance work order on a space. Assign a vendor and progress it separately; a repair cost is billed through accounts payable.',
      input_schema: schema(
        { id: str('Client-chosen work order id.'), title: str('Short problem summary.'), spaceId: str('Space the issue is on. Optional.'), priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'], description: 'Priority. Optional.' }, description: str('Details. Optional.') },
        ['id', 'title'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/work-orders', body: i }),
  },
  {
    spec: {
      name: 'reserve_space',
      description: 'Reserve a bookable common area or amenity for a window. Takes a calendar hold so overlaps are rejected by the same no-double-booking guarantee as stays.',
      input_schema: schema(
        { id: str('Client-chosen reservation id.'), spaceId: str('Common/amenity space id.'), holderPartyId: str('Party reserving it.'), start: str('Start, ISO-8601.'), end: str('End, ISO-8601.'), priceCents: int('Price in cents. Optional.'), note: str('Note. Optional.') },
        ['id', 'spaceId', 'holderPartyId', 'start', 'end'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/reservations', body: i }),
  },
  {
    spec: {
      name: 'open_thread',
      description: 'Open a conversation thread (resident, finance, or internal), optionally scoped to an agreement or party. Then use send_message to reply.',
      input_schema: schema(
        { id: str('Client-chosen thread id.'), subject: str('Thread subject.'), kind: { type: 'string', enum: ['resident', 'finance', 'internal'], description: 'Thread kind.' }, agreementId: str('Scope to an agreement. Optional.'), partyId: str('Scope to a party. Optional.') },
        ['id', 'subject', 'kind'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/threads', body: i }),
  },
  {
    spec: {
      name: 'send_message',
      description: 'Append a message to a thread. An agent-authored message is recorded with authorType=agent and outbound direction — this is the AI communications surface, and it passes the policy envelope like any agent action.',
      input_schema: schema({ threadId: str('Thread id.'), id: str('Client-chosen message id.'), body: str('Message text.') }, ['threadId', 'id', 'body']),
      strict: true,
    },
    toRequest: (i) => {
      const { threadId, ...body } = i;
      return { method: 'POST', path: `/threads/${threadId}/messages`, body };
    },
  },
  // --- accounts payable (issue only; paying large amounts escalates) ------
  {
    spec: {
      name: 'record_bill',
      description:
        'Record a vendor bill (accounts payable) against a payee party. This posts the payable; PAYING it is a separate step that escalates for large amounts and is not available to an agent. A resident refund is modelled as a bill to the resident-payee.',
      input_schema: schema(
        {
          id: str('Client-chosen bill id.'),
          payeeId: str('Party being paid (a vendor or a resident being refunded).'),
          dueAt: str('Due date, ISO-8601.'),
          poId: str('Purchase order this fulfils. Optional.'),
          lines: {
            type: 'array',
            description: 'Bill lines.',
            items: schema({ description: str('Line description.'), account: str('Expense account, e.g. expenses:repairs.'), amountCents: int('Positive integer cents.') }, ['description', 'account', 'amountCents']),
          },
        },
        ['id', 'payeeId', 'dueAt', 'lines'],
      ),
      strict: true,
    },
    toRequest: (i) => ({ method: 'POST', path: '/bills', body: i }),
  },
];

export class AgentToolCatalog {
  private readonly byName = new Map<string, ToolDef>();

  constructor(private readonly app: App) {
    for (const t of TOOLS) this.byName.set(t.spec.name, t);
  }

  /** Tool definitions to hand an LLM (drops into the Anthropic SDK `tools`). */
  specs(): ToolSpec[] {
    return TOOLS.map((t) => ({ ...t.spec, input_schema: { ...t.spec.input_schema } }));
  }

  names(): string[] {
    return [...this.byName.keys()];
  }

  /**
   * Execute one tool-call for the agent identified by `bearer`. Routes through
   * App.dispatch, so the policy envelope runs before any effect. Unknown tools
   * and dispatch errors come back as `isError` tool results the model can read.
   */
  invoke(name: string, input: Record<string, unknown>, bearer: string): ToolResult {
    const tool = this.byName.get(name);
    if (!tool) {
      return { content: JSON.stringify({ error: `unknown tool: ${name}` }), isError: true, status: 404 };
    }
    const req = tool.toRequest(input ?? {});
    const res = this.app.dispatch({ ...req, bearer });
    return {
      content: JSON.stringify(res.body),
      isError: res.status >= 400,
      status: res.status,
    };
  }
}
