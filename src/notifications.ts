// Notification transport — the outbox that carries reminders/receipts/e-sign
// requests to guests over email/SMS. Same discipline as the connector framework:
// the kernel only RECORDS a notification (channel + recipient + a canonical kind +
// non-secret template data); the actual send happens in an edge worker that
// resolves the provider credential (SendGrid/Twilio/…) from the secret store. NO
// credential ever enters the kernel. Pure + zero-dependency.

export type NotificationChannel = 'email' | 'sms';
export type NotificationStatus = 'pending' | 'sent' | 'failed';

/** Canonical notification kinds — the vocabulary the edge templates render, so a
 *  trigger just names a kind + supplies its data (vendor/template independent). */
export interface NotificationKindSpec {
  kind: string;
  description: string;
  /** Data keys a well-formed notification of this kind should carry. */
  data: readonly string[];
}

export const NOTIFICATION_KINDS: readonly NotificationKindSpec[] = [
  { kind: 'collections_reminder', description: 'An overdue-invoice reminder.', data: ['invoiceId', 'amountCents'] },
  { kind: 'payment_receipt', description: 'A receipt for a recorded payment.', data: ['invoiceId', 'amountCents'] },
  { kind: 'esign_request', description: 'A request to sign a document.', data: ['envelopeId', 'documentName'] },
  { kind: 'work_order_update', description: 'A maintenance work-order status update.', data: ['workOrderId'] },
  { kind: 'general', description: 'A free-form operator message.', data: ['subject', 'body'] },
];

export function isKnownNotificationKind(kind: string): boolean {
  return NOTIFICATION_KINDS.some((k) => k.kind === kind);
}

export interface NotificationRecord {
  id: string;
  tenantId: string;
  channel: NotificationChannel;
  /** Destination address (email) or number (SMS) — PII, but never a secret. */
  to: string;
  kind: string;
  /** Template variables (non-secret). */
  data: Record<string, unknown>;
  status: NotificationStatus;
  createdAt: string;
  sentAt?: string;
  failedReason?: string;
  /** The provider's external message id, set by the edge worker on send. */
  providerRef?: string;
}

export class NotificationError extends Error {}

const CHANNELS: readonly NotificationChannel[] = ['email', 'sms'];

export class Notifications {
  private byId = new Map<string, NotificationRecord>();

  /** Load stored notifications for cold-start rehydration. */
  hydrate(records: readonly NotificationRecord[]): void {
    for (const r of records) this.byId.set(r.id, { ...r, data: { ...r.data } });
  }

  enqueue(input: {
    id: string;
    tenantId: string;
    channel: NotificationChannel;
    to: string;
    kind: string;
    createdAt: string;
    data?: Record<string, unknown>;
  }): NotificationRecord {
    if (this.byId.has(input.id)) throw new NotificationError(`duplicate notification: ${input.id}`);
    if (!CHANNELS.includes(input.channel)) throw new NotificationError(`unknown channel: ${input.channel}`);
    if (!input.to) throw new NotificationError(`notification ${input.id}: a recipient (to) is required`);
    if (!isKnownNotificationKind(input.kind)) throw new NotificationError(`unknown notification kind: ${input.kind}`);
    const rec: NotificationRecord = {
      id: input.id,
      tenantId: input.tenantId,
      channel: input.channel,
      to: input.to,
      kind: input.kind,
      data: { ...(input.data ?? {}) },
      status: 'pending',
      createdAt: input.createdAt,
    };
    this.byId.set(rec.id, rec);
    return this.get(rec.id);
  }

  get(id: string): NotificationRecord {
    const r = this.byId.get(id);
    if (!r) throw new NotificationError(`unknown notification: ${id}`);
    return { ...r, data: { ...r.data } };
  }

  /** The edge worker reports a successful send. */
  markSent(id: string, at: string, providerRef?: string): NotificationRecord {
    const r = this.byId.get(id);
    if (!r) throw new NotificationError(`unknown notification: ${id}`);
    if (r.status === 'sent') return this.get(id); // idempotent re-report
    r.status = 'sent';
    r.sentAt = at;
    if (providerRef) r.providerRef = providerRef;
    return this.get(id);
  }

  /** The edge worker reports a failed send (a retry can re-enqueue a new record). */
  markFailed(id: string, at: string, reason: string): NotificationRecord {
    const r = this.byId.get(id);
    if (!r) throw new NotificationError(`unknown notification: ${id}`);
    r.status = 'failed';
    r.sentAt = at;
    r.failedReason = reason;
    return this.get(id);
  }

  pending(tenantId: string): NotificationRecord[] {
    return this.list(tenantId, { status: 'pending' });
  }

  /** Redact the recipient address of every notification sent to `recipient` for a
   *  tenant (LGPD/GDPR erasure — the recipient is the PII). The kind + financial
   *  data keys stay as a non-identifying delivery record. Returns the count redacted. */
  redactRecipient(tenantId: string, recipient: string, tombstone: string): number {
    let n = 0;
    for (const r of this.byId.values()) {
      if (r.tenantId === tenantId && r.to === recipient) {
        r.to = tombstone;
        n++;
      }
    }
    return n;
  }

  list(tenantId: string, filter: { status?: NotificationStatus; channel?: NotificationChannel } = {}): NotificationRecord[] {
    return [...this.byId.values()]
      .filter(
        (r) =>
          r.tenantId === tenantId &&
          (filter.status === undefined || r.status === filter.status) &&
          (filter.channel === undefined || r.channel === filter.channel),
      )
      .map((r) => this.get(r.id));
  }
}
