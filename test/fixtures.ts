import { DEFAULT_ROUTES, type Config, type RepoConfig, type Workplace } from "../src/config.js";
import type { PullState } from "../src/github/pulls.js";

export function workplace(overrides: Partial<Workplace> = {}): Workplace {
  const wp: Workplace = {
    path: "/work",
    agent: "claude",
    allow: ["ungood"],
    routes: { ...DEFAULT_ROUTES },
    repos: [],
    ...overrides,
  };
  wp.repos = [{ name: "ungood/factory", path: "/work", workplace: wp }];
  return wp;
}

export function config(wp = workplace()): Config {
  return {
    workplaces: [wp],
    pollSeconds: 30,
    sweepSeconds: 300,
    orcaBin: "orca",
    github: { appId: 1, privateKeyCommand: "true", webhookSecretCommand: "true" },
  };
}

export const repoOf = (c: Config): RepoConfig => c.workplaces[0]!.repos[0]!;

export function pull(overrides: Partial<PullState> = {}): PullState {
  return {
    repo: "ungood/factory",
    number: 7,
    url: "https://github.com/ungood/factory/pull/7",
    title: "Add a thing",
    state: "OPEN",
    author: "ungood",
    headRef: "ungood/thing",
    headSha: "aaaaaaa1111111",
    baseRef: "main",
    fromFork: false,
    mergeable: "MERGEABLE",
    checks: { state: "SUCCESS", failing: [] },
    feedback: [],
    ...overrides,
  };
}
