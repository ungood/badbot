import { describe, expect, it } from "vitest";
import { fill, signalsFor, type SignalContext } from "../src/signals.js";
import { pull } from "./fixtures.js";

const ctx = (overrides: Partial<SignalContext> = {}): SignalContext => ({
  allow: ["ungood"],
  since: "2026-10-01T00:00:00Z",
  handled: new Set(),
  ...overrides,
});

const comment = (
  id: string,
  author = "ungood",
  body = "please fix",
  createdAt = "2026-10-18T00:00:00Z",
) => ({
  id,
  url: `https://github.com/c/${id}`,
  author,
  body,
  createdAt,
  where: "src/main.ts",
});

describe("signalsFor", () => {
  it("is quiet for a healthy PR", () => {
    expect(signalsFor(pull(), ctx({ behind: { by: 0, baseSha: "b" } }))).toEqual([]);
  });

  it("collects new feedback from allowed people only", () => {
    const p = pull({
      feedback: [
        comment("1"),
        comment("2", "stranger"),
        comment("3", "ungood[bot]", "Fixed."),
        comment("4", "ungood", "old", "2026-09-01T00:00:00Z"),
        comment("5"),
      ],
    });
    const [review] = signalsFor(p, ctx({ handled: new Set(["review:5"]) }));
    expect(review?.kind).toBe("review");
    expect(review?.keys).toEqual(["review:1"]);
    expect(review?.details).toContain("> please fix");
  });

  it("reports failing checks once per head commit", () => {
    const p = pull({
      checks: { state: "FAILURE", failing: [{ name: "test", url: "https://ci/1" }] },
    });
    const [ci] = signalsFor(p, ctx());
    expect(ci).toMatchObject({ kind: "ci_failed", keys: ["ci:aaaaaaa1111111"] });
    expect(ci?.details).toBe("- test (https://ci/1)");
    expect(signalsFor(p, ctx({ handled: new Set(["ci:aaaaaaa1111111"]) }))).toEqual([]);
  });

  it("reports a conflict instead of being behind", () => {
    const p = pull({ mergeable: "CONFLICTING" });
    const kinds = signalsFor(p, ctx({ behind: { by: 3, baseSha: "b" } })).map((s) => s.kind);
    expect(kinds).toEqual(["conflicted"]);
  });

  it("reports each move of the base branch once", () => {
    const first = signalsFor(pull(), ctx({ behind: { by: 2, baseSha: "base1" } }));
    expect(first).toEqual([
      { kind: "behind", keys: ["behind:aaaaaaa1111111:base1"], details: "2 commits behind main" },
    ]);
    const handled = new Set(first[0]!.keys);
    expect(signalsFor(pull(), ctx({ handled, behind: { by: 2, baseSha: "base1" } }))).toEqual([]);
    expect(signalsFor(pull(), ctx({ handled, behind: { by: 3, baseSha: "base2" } }))).toHaveLength(
      1,
    );
  });
});

describe("fill", () => {
  it("fills known placeholders and leaves others alone", () => {
    expect(fill("{url} on {branch} vs {base} at {head}: {details} {nope}", pull(), "x")).toBe(
      "https://github.com/ungood/factory/pull/7 on ungood/thing vs main at aaaaaaa: x {nope}",
    );
  });
});
