import { describe, expect, it } from "vitest";
import { entitiesFor } from "../src/github/events.js";
import { isInboxMessage } from "../src/inbox/message.js";

const repository = { full_name: "ungood/factory" };

describe("entitiesFor", () => {
  it("maps review activity to its PR", () => {
    for (const event of [
      "pull_request",
      "pull_request_review",
      "pull_request_review_comment",
      "pull_request_review_thread",
    ]) {
      expect(entitiesFor(event, { repository, pull_request: { number: 7 } })).toEqual([
        { kind: "pull", repo: "ungood/factory", number: 7 },
      ]);
    }
  });

  it("tells PR conversation comments from issue comments", () => {
    expect(
      entitiesFor("issue_comment", { repository, issue: { number: 7, pull_request: {} } }),
    ).toEqual([{ kind: "pull", repo: "ungood/factory", number: 7 }]);
    expect(entitiesFor("issue_comment", { repository, issue: { number: 8 } })).toEqual([
      { kind: "issue", repo: "ungood/factory", number: 8 },
    ]);
  });

  it("maps a completed check suite to every PR it ran for", () => {
    const payload = {
      repository,
      check_suite: { status: "completed", pull_requests: [{ number: 1 }, { number: 2 }] },
    };
    expect(entitiesFor("check_suite", payload).map((e) => "number" in e && e.number)).toEqual([
      1, 2,
    ]);
    expect(
      entitiesFor("check_suite", { ...payload, check_suite: { status: "in_progress" } }),
    ).toEqual([]);
  });

  it("maps a push to the branch that moved", () => {
    expect(entitiesFor("push", { repository, ref: "refs/heads/main" })).toEqual([
      { kind: "branch", repo: "ungood/factory", branch: "main" },
    ]);
    expect(entitiesFor("push", { repository, ref: "refs/tags/v1" })).toEqual([]);
    expect(entitiesFor("push", { repository, ref: "refs/heads/gone", deleted: true })).toEqual([]);
  });

  it("drops events it doesn't route", () => {
    expect(entitiesFor("star", { repository })).toEqual([]);
    expect(entitiesFor("pull_request", {})).toEqual([]);
  });
});

describe("isInboxMessage", () => {
  it("accepts what the Worker queues and rejects anything else", () => {
    const ok = {
      source: "github",
      deliveryId: "d1",
      event: "push",
      entity: { kind: "branch", repo: "a/b", branch: "main" },
      receivedAt: "2026-10-18T00:00:00Z",
    };
    expect(isInboxMessage(ok)).toBe(true);
    expect(isInboxMessage({ ...ok, entity: { kind: "pull", repo: "a/b" } })).toBe(false);
    expect(isInboxMessage("nope")).toBe(false);
  });
});
