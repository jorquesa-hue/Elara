// Communications (#4). Threaded messages between residents and operations,
// finance (collections), and internal teams. A thread is scoped to a tenant and
// optionally to an agreement and/or a party; messages append to it. A message
// may be authored by a party (resident), a user (staff), or an agent (AI) —
// every agent-authored send still passes the policy envelope, so autonomous
// resident communication is gated exactly like any other agent action. The
// kernel records and orders messages; drafting/among external channels
// (email/WhatsApp) is an integration concern outside the zero-dep kernel.

export type ThreadKind = 'resident' | 'finance' | 'internal';
export type ThreadStatus = 'open' | 'resolved';
export type MessageAuthor = 'party' | 'user' | 'agent';
export type MessageDirection = 'inbound' | 'outbound' | 'internal';

export interface ThreadRecord {
  id: string;
  tenantId: string;
  subject: string;
  kind: ThreadKind;
  status: ThreadStatus;
  agreementId?: string;
  partyId?: string;
  createdAt: string;
  resolvedAt?: string;
}

export interface MessageRecord {
  id: string;
  threadId: string;
  at: string;
  authorType: MessageAuthor;
  authorId: string;
  body: string;
  direction: MessageDirection;
}

export class CommsError extends Error {}

const THREAD_KINDS: readonly ThreadKind[] = ['resident', 'finance', 'internal'];

export class Communications {
  private threads = new Map<string, ThreadRecord>();
  private messages: MessageRecord[] = [];

  openThread(input: {
    id: string;
    tenantId: string;
    subject: string;
    kind: ThreadKind;
    createdAt: string;
    agreementId?: string;
    partyId?: string;
  }): ThreadRecord {
    if (this.threads.has(input.id)) throw new CommsError(`duplicate thread: ${input.id}`);
    if (!input.subject) throw new CommsError(`thread ${input.id}: subject is required`);
    if (!THREAD_KINDS.includes(input.kind)) throw new CommsError(`unknown thread kind: ${input.kind}`);
    const rec: ThreadRecord = {
      id: input.id,
      tenantId: input.tenantId,
      subject: input.subject,
      kind: input.kind,
      status: 'open',
      agreementId: input.agreementId,
      partyId: input.partyId,
      createdAt: input.createdAt,
    };
    this.threads.set(rec.id, rec);
    return { ...rec };
  }

  getThread(id: string): ThreadRecord {
    const t = this.threads.get(id);
    if (!t) throw new CommsError(`unknown thread: ${id}`);
    return { ...t };
  }

  /** Append a message to an open thread. */
  post(input: {
    id: string;
    threadId: string;
    at: string;
    authorType: MessageAuthor;
    authorId: string;
    body: string;
    direction?: MessageDirection;
  }): MessageRecord {
    const thread = this.threads.get(input.threadId);
    if (!thread) throw new CommsError(`unknown thread: ${input.threadId}`);
    if (thread.status === 'resolved') throw new CommsError(`thread ${input.threadId} is resolved; reopen to post`);
    if (this.messages.some((m) => m.id === input.id)) throw new CommsError(`duplicate message: ${input.id}`);
    if (!input.body) throw new CommsError(`message ${input.id}: body is required`);
    const direction =
      input.direction ??
      (thread.kind === 'internal' ? 'internal' : input.authorType === 'party' ? 'inbound' : 'outbound');
    const msg: MessageRecord = {
      id: input.id,
      threadId: input.threadId,
      at: input.at,
      authorType: input.authorType,
      authorId: input.authorId,
      body: input.body,
      direction,
    };
    this.messages.push(msg);
    return { ...msg };
  }

  resolve(id: string, at: string): ThreadRecord {
    const t = this.threads.get(id);
    if (!t) throw new CommsError(`unknown thread: ${id}`);
    t.status = 'resolved';
    t.resolvedAt = at;
    return { ...t };
  }

  reopen(id: string): ThreadRecord {
    const t = this.threads.get(id);
    if (!t) throw new CommsError(`unknown thread: ${id}`);
    t.status = 'open';
    t.resolvedAt = undefined;
    return { ...t };
  }

  messagesFor(threadId: string): MessageRecord[] {
    return this.messages.filter((m) => m.threadId === threadId).map((m) => ({ ...m }));
  }

  listThreads(tenantId: string, filter: { kind?: ThreadKind; status?: ThreadStatus; agreementId?: string } = {}): ThreadRecord[] {
    return [...this.threads.values()]
      .filter(
        (t) =>
          t.tenantId === tenantId &&
          (filter.kind === undefined || t.kind === filter.kind) &&
          (filter.status === undefined || t.status === filter.status) &&
          (filter.agreementId === undefined || t.agreementId === filter.agreementId),
      )
      .map((t) => ({ ...t }));
  }

  allThreads(): readonly ThreadRecord[] {
    return [...this.threads.values()].map((t) => ({ ...t }));
  }

  allMessages(): readonly MessageRecord[] {
    return this.messages.map((m) => ({ ...m }));
  }
}
