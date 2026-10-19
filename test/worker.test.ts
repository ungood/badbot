import { describe, expect, it } from "vitest";
import { signBody } from "../src/github/signature.js";

// Imported by path so the Node type-check doesn't pull in the Workers types.
const workerPath = "../worker/index.ts";
const { default: worker } = (await import(workerPath)) as {
  default: { fetch: (req: Request, env: unknown) => Promise<Response> };
};

function env() {
  const sent: { body: unknown; contentType: string }[] = [];
  return {
    sent,
    env: {
      GITHUB_WEBHOOK_SECRET: "s3cret",
      INBOX: {
        sendBatch: async (batch: { body: unknown; contentType: string }[]) =>
          void sent.push(...batch),
      },
    },
  };
}

async function deliver(event: string, payload: unknown, secret = "s3cret", path = "/github") {
  const body = JSON.stringify(payload);
  return new Request(`https://inbox.example${path}`, {
    method: "POST",
    body,
    headers: {
      "x-github-event": event,
      "x-github-delivery": "guid-1",
      "x-hub-signature-256": await signBody(secret, body),
    },
  });
}

describe("the inbox Worker", () => {
  it("queues a JSON reference for each entity a signed delivery touches", async () => {
    const { sent, env: e } = env();
    const payload = {
      repository: { full_name: "ungood/factory" },
      check_suite: { status: "completed", pull_requests: [{ number: 1 }, { number: 2 }] },
    };
    const res = await worker.fetch(await deliver("check_suite", payload), e);
    expect(res.status).toBe(202);
    expect(sent.map((m) => m.contentType)).toEqual(["json", "json"]);
    expect(sent[0]?.body).toMatchObject({
      source: "github",
      deliveryId: "guid-1",
      event: "check_suite",
      entity: { kind: "pull", repo: "ungood/factory", number: 1 },
    });
  });

  it("rejects a bad signature and other paths", async () => {
    const { sent, env: e } = env();
    const payload = { repository: { full_name: "a/b" }, pull_request: { number: 1 } };
    expect((await worker.fetch(await deliver("pull_request", payload, "wrong"), e)).status).toBe(
      401,
    );
    expect(
      (await worker.fetch(await deliver("pull_request", payload, "s3cret", "/x"), e)).status,
    ).toBe(404);
    expect(sent).toEqual([]);
  });

  it("accepts events it doesn't route without queueing anything", async () => {
    const { sent, env: e } = env();
    const res = await worker.fetch(
      await deliver("ping", { zen: "hi", repository: { full_name: "a/b" } }),
      e,
    );
    expect(res.status).toBe(202);
    expect(sent).toEqual([]);
  });
});
