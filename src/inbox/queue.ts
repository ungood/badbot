// Pulls inbox messages from the Cloudflare Queue over HTTP. A message is
// acknowledged only after the router has acted on it, so anything that fails
// comes back after its lease runs out.

import { isInboxMessage, type InboxMessage } from "./message.js";

const API = "https://api.cloudflare.com/client/v4";

export interface Leased {
  leaseId: string;
  attempts: number;
  message: InboxMessage | undefined;
}

interface Envelope<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  result: T;
}

export function decodeBody(body: unknown): unknown {
  if (typeof body !== "string") return body;
  try {
    return JSON.parse(body);
  } catch {
    try {
      return JSON.parse(Buffer.from(body, "base64").toString("utf8"));
    } catch {
      return undefined;
    }
  }
}

export class CloudflareQueue {
  private queueId: string | undefined;

  constructor(
    private readonly accountId: string,
    private readonly token: string,
    private readonly queueName: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async api<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchImpl(`${API}/accounts/${this.accountId}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
    });
    const envelope = (await response.json()) as Envelope<T>;
    if (!response.ok || !envelope.success) {
      const errors = envelope.errors?.map((e) => `${e.code} ${e.message}`).join("; ");
      throw new Error(`Cloudflare ${path}: ${response.status} ${errors ?? ""}`.trim());
    }
    return envelope.result;
  }

  private async id(): Promise<string> {
    if (!this.queueId) {
      const queues =
        await this.api<{ queue_id: string; queue_name: string }[]>(`/queues?per_page=100`);
      const queue = queues.find((q) => q.queue_name === this.queueName);
      if (!queue)
        throw new Error(
          `no Cloudflare queue named ${this.queueName}; run \`badbot inbox install\``,
        );
      this.queueId = queue.queue_id;
    }
    return this.queueId;
  }

  async pull(batchSize = 50, visibilityTimeoutMs = 120_000): Promise<Leased[]> {
    const result = await this.api<{
      messages: { lease_id: string; attempts: number; body: unknown }[];
    }>(`/queues/${await this.id()}/messages/pull`, {
      method: "POST",
      body: JSON.stringify({ batch_size: batchSize, visibility_timeout_ms: visibilityTimeoutMs }),
    });
    return result.messages.map((m) => {
      const body = decodeBody(m.body);
      return {
        leaseId: m.lease_id,
        attempts: m.attempts,
        message: isInboxMessage(body) ? body : undefined,
      };
    });
  }

  async settle(acks: string[], retries: string[]): Promise<void> {
    if (acks.length === 0 && retries.length === 0) return;
    await this.api(`/queues/${await this.id()}/messages/ack`, {
      method: "POST",
      body: JSON.stringify({
        acks: acks.map((lease_id) => ({ lease_id })),
        retries: retries.map((lease_id) => ({ lease_id, delay_seconds: 60 })),
      }),
    });
  }
}
