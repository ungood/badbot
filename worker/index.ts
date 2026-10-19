// The GitHub inbox: verifies each delivery, queues a reference to every
// entity it touches, and answers well within GitHub's 10-second deadline.

import { entitiesFor } from "../src/github/events.js";
import { verifySignature } from "../src/github/signature.js";
import type { InboxMessage } from "../src/inbox/message.js";

interface Env {
  INBOX: Queue<InboxMessage>;
  GITHUB_WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/github") {
      return new Response("not found", { status: 404 });
    }
    const body = await request.text();
    const signature = request.headers.get("x-hub-signature-256");
    if (!(await verifySignature(env.GITHUB_WEBHOOK_SECRET, body, signature))) {
      return new Response("bad signature", { status: 401 });
    }
    const event = request.headers.get("x-github-event") ?? "";
    const deliveryId = request.headers.get("x-github-delivery") ?? "";
    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("bad json", { status: 400 });
    }
    const receivedAt = new Date().toISOString();
    const messages = entitiesFor(event, payload).map((entity) => ({
      body: { source: "github", deliveryId, event, entity, receivedAt } satisfies InboxMessage,
      // The daemon pulls over HTTP, which can't decode the default v8 format.
      contentType: "json" as const,
    }));
    if (messages.length > 0) await env.INBOX.sendBatch(messages);
    return new Response(null, { status: 202 });
  },
};
