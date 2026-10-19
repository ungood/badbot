import { describe, expect, it } from "vitest";
import { failedDeliveries } from "../src/github/client.js";
import { normalizePull } from "../src/github/pulls.js";
import { decodeBody } from "../src/inbox/queue.js";
import { APP_EVENTS, manifest } from "../src/github/app-create.js";
import { entitiesFor } from "../src/github/events.js";

describe("normalizePull", () => {
  it("collects failing checks and unresolved feedback", () => {
    const p = normalizePull("a/b", {
      number: 1,
      url: "u",
      title: "t",
      state: "OPEN",
      author: { login: "ungood" },
      headRefName: "h",
      headRefOid: "sha",
      baseRefName: "main",
      mergeable: "MERGEABLE",
      isCrossRepository: false,
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: {
                  nodes: [
                    {
                      __typename: "CheckRun",
                      name: "lint",
                      conclusion: "FAILURE",
                      detailsUrl: "d",
                    },
                    {
                      __typename: "CheckRun",
                      name: "test",
                      conclusion: "SUCCESS",
                      detailsUrl: "d",
                    },
                    {
                      __typename: "StatusContext",
                      context: "ci/old",
                      state: "ERROR",
                      targetUrl: null,
                    },
                  ],
                },
              },
            },
          },
        ],
      },
      comments: {
        nodes: [
          { id: "c1", url: "u1", body: "hi", createdAt: "2026-10-02", author: { login: "ungood" } },
        ],
      },
      reviews: {
        nodes: [
          {
            id: "r1",
            url: "u2",
            body: "",
            state: "COMMENTED",
            submittedAt: "2026-10-03",
            author: { login: "ungood" },
          },
          {
            id: "r2",
            url: "u3",
            body: "redo",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-10-01",
            author: { login: "ungood" },
          },
        ],
      },
      reviewThreads: {
        nodes: [
          {
            isResolved: true,
            path: "a.ts",
            comments: {
              nodes: [{ id: "t1", url: "u4", body: "x", createdAt: "2026-10-04", author: null }],
            },
          },
          {
            isResolved: false,
            path: "b.ts",
            comments: {
              nodes: [
                {
                  id: "t2",
                  url: "u5",
                  body: "y",
                  createdAt: "2026-10-05",
                  author: { login: "ungood" },
                },
              ],
            },
          },
        ],
      },
    });
    expect(p.checks.failing.map((c) => c.name)).toEqual(["lint", "ci/old"]);
    expect(p.feedback.map((f) => [f.id, f.where])).toEqual([
      ["r2", "review (changes requested)"],
      ["c1", "comment"],
      ["t2", "b.ts"],
    ]);
  });
});

describe("bot logins", () => {
  it("tells the App's bot from the user it's named after", () => {
    const p = normalizePull("a/b", {
      number: 1,
      author: { __typename: "Bot", login: "ungood" },
      comments: {
        nodes: [
          {
            id: "c",
            url: "u",
            body: "b",
            createdAt: "x",
            author: { __typename: "User", login: "ungood" },
          },
        ],
      },
    });
    expect(p.author).toBe("ungood[bot]");
    expect(p.feedback[0]?.author).toBe("ungood");
  });
});

describe("failedDeliveries", () => {
  it("returns deliveries with no successful attempt, once each", () => {
    const d = (id: number, guid: string, ok: boolean, at: string) => ({
      id,
      guid,
      ok,
      deliveredAt: at,
      redelivery: false,
    });
    expect(
      failedDeliveries([
        d(3, "g1", true, "3"),
        d(2, "g1", false, "2"),
        d(5, "g2", false, "5"),
        d(4, "g2", false, "4"),
      ]).map((x) => x.id),
    ).toEqual([4]);
  });
});

describe("decodeBody", () => {
  it("reads JSON bodies, base64-wrapped or not", () => {
    expect(decodeBody('{"a":1}')).toEqual({ a: 1 });
    expect(decodeBody(Buffer.from('{"a":1}').toString("base64"))).toEqual({ a: 1 });
    expect(decodeBody({ a: 1 })).toEqual({ a: 1 });
  });
});

describe("App manifest", () => {
  it("subscribes only to events the inbox routes", () => {
    const repository = { full_name: "a/b" };
    const samples: Record<string, unknown> = {
      check_suite: {
        repository,
        check_suite: { status: "completed", pull_requests: [{ number: 1 }] },
      },
      issue_comment: { repository, issue: { number: 1 } },
      issues: { repository, issue: { number: 1 } },
      pull_request: { repository, pull_request: { number: 1 } },
      pull_request_review: { repository, pull_request: { number: 1 } },
      pull_request_review_comment: { repository, pull_request: { number: 1 } },
      pull_request_review_thread: { repository, pull_request: { number: 1 } },
      push: { repository, ref: "refs/heads/main" },
      workflow_run: {
        repository,
        workflow_run: { status: "completed", pull_requests: [{ number: 1 }] },
      },
    };
    for (const event of APP_EVENTS) expect(entitiesFor(event, samples[event])).toHaveLength(1);
  });

  it("leaves the webhook off until the inbox exists", () => {
    expect(manifest("ungood", "http://127.0.0.1:1/done", undefined)).toMatchObject({
      name: "ungood",
      public: false,
      hook_attributes: { active: false },
    });
  });
});
