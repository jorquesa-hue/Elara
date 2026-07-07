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
