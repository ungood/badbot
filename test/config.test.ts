import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTES, parseWorkplace } from "../src/config.js";

describe("parseWorkplace", () => {
  it("resolves repo paths and fills in default routes", () => {
    const wp = parseWorkplace(
      "/work",
      `allow = ["ungood"]
[repos."ungood/factory"]
[repos."ungood/place"]
path = "place"
[routes.behind]
run = "mise run rebase"
[routes.review]
enabled = false
`,
    );
    expect(wp.agent).toBe("claude");
    expect(wp.repos.map((r) => [r.name, r.path])).toEqual([
      ["ungood/factory", "/work"],
      ["ungood/place", "/work/place"],
    ]);
    expect(wp.routes.behind).toEqual({ enabled: true, run: "mise run rebase" });
    expect(wp.routes.review.enabled).toBe(false);
    expect(wp.routes.ci_failed).toEqual(DEFAULT_ROUTES.ci_failed);
  });

  it("requires an allowlist and known routes", () => {
    expect(() => parseWorkplace("/w", "")).toThrow(/allow/);
    expect(() => parseWorkplace("/w", 'allow = ["a"]\n[routes.merged]\n')).toThrow(
      /unknown route "merged"/,
    );
  });
});
