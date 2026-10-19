import { describe, expect, it } from "vitest";
import { signBody, verifySignature } from "../src/github/signature.js";

describe("verifySignature", () => {
  it("matches GitHub's documented example", async () => {
    // https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    expect(await signBody("It's a Secret to Everybody", "Hello, World!")).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });

  it("rejects a missing or wrong signature", async () => {
    const good = await signBody("s", "body");
    expect(await verifySignature("s", "body", good)).toBe(true);
    expect(await verifySignature("s", "body!", good)).toBe(false);
    expect(await verifySignature("other", "body", good)).toBe(false);
    expect(await verifySignature("s", "body", null)).toBe(false);
  });
});
