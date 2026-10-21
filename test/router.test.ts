import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { GitHub } from "../src/github/client.js";
import type { PullState } from "../src/github/pulls.js";
import type { Orca, Terminal, Worktree } from "../src/orca/cli.js";
import { pullKey, Router } from "../src/router.js";
import { Store } from "../src/state.js";
import { config, pull, repoOf } from "./fixtures.js";

class FakeOrca {
  terminalList: Terminal[] = [];
  worktreeList: Worktree[] = [
    { id: "r1::/work", repoId: "r1", path: "/work", branch: "refs/heads/main", isArchived: false },
  ];
  created: string[] = [];
  started: { worktreeId: string; command: string }[] = [];
  prompts: { terminal: string; text: string }[] = [];
  private next = 1;

  async terminals() {
    return this.terminalList;
  }
  async repoId(path: string) {
    return path === "/work" ? "r1" : undefined;
  }
  async worktrees() {
    return this.worktreeList;
  }
  async createWorktree(_repo: string, name: string) {
    this.created.push(name);
    this.worktreeList.push({
      id: `r1::/wt/${name}`,
      repoId: "r1",
      path: `/wt/${name}`,
      branch: "refs/heads/main",
      isArchived: false,
    });
  }
  async startAgent(worktreeId: string, command: string) {
    this.started.push({ worktreeId, command });
    const handle = `term_agent${this.next++}`;
    this.terminalList.push({ handle, worktreeId, agentIdentity: "claude" });
    return handle;
  }
  async prompt(terminal: string, text: string) {
    this.prompts.push({ terminal, text });
  }
}

class FakeGitHub {
  pulls = new Map<number, PullState>();
  behindBy = { by: 0, baseSha: "base0" };
  async pull(_repo: string, number: number) {
    return this.pulls.get(number);
  }
  async openPulls() {
    return [...this.pulls.values()].filter((p) => p.state === "OPEN");
  }
  async behind() {
    return this.behindBy;
  }
}

const failing = (sha: string) =>
  pull({ headSha: sha, checks: { state: "FAILURE", failing: [{ name: "test", url: null }] } });

describe("Router", () => {
  let orca: FakeOrca;
  let github: FakeGitHub;
  let store: Store;
  let router: Router;
  const c = config();
  const repo = repoOf(c);
  const key = pullKey("ungood/factory", 7);

  beforeEach(async () => {
    orca = new FakeOrca();
    github = new FakeGitHub();
    store = await Store.open(await mkdtemp(join(tmpdir(), "badbot-test-")));
    store.state.startedAt = "2026-10-01T00:00:00Z";
    router = new Router(
      c,
      store,
      github as unknown as GitHub,
      orca as unknown as Orca,
      () => undefined,
      "ungood[bot]",
    );
  });

  it("starts an agent in a new worktree when nobody has the PR's branch", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    expect(orca.created).toEqual(["ungood-thing"]);
    expect(orca.started).toEqual([{ worktreeId: "r1::/wt/ungood-thing", command: "claude" }]);
    expect(orca.prompts).toHaveLength(1);
    // The new worktree isn't on the PR's branch yet.
    expect(orca.prompts[0]!.text).toContain("gh pr checkout 7");
    expect(orca.prompts[0]!.text).toContain("Checks failed");
    expect(store.state.pulls[key]?.owner).toEqual({
      worktreeId: "r1::/wt/ungood-thing",
      terminal: orca.prompts[0]!.terminal,
    });
  });

  it("tells the agent already open in the PR's worktree", async () => {
    orca.worktreeList.push({
      id: "r1::/wt/x",
      repoId: "r1",
      path: "/wt/x",
      branch: "refs/heads/ungood/thing",
      isArchived: false,
    });
    orca.terminalList.push({
      handle: "term_mine",
      worktreeId: "r1::/wt/x",
      agentIdentity: "claude",
    });
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    expect(orca.created).toEqual([]);
    expect(orca.started).toEqual([]);
    expect(orca.prompts[0]!.terminal).toBe("term_mine");
    expect(orca.prompts[0]!.text).not.toContain("gh pr checkout");
  });

  it("keeps telling the same agent, and starts another only once its terminal is gone", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    const first = store.state.pulls[key]!.owner!.terminal;

    github.pulls.set(7, failing("sha2"));
    await router.reconcilePull(repo, 7, "event");
    expect(orca.started).toHaveLength(1);
    expect(orca.prompts.map((p) => p.terminal)).toEqual([first, first]);

    orca.terminalList = [];
    github.pulls.set(7, failing("sha3"));
    await router.reconcilePull(repo, 7, "event");
    expect(orca.created).toHaveLength(1);
    expect(orca.started).toHaveLength(2);
    expect(store.state.pulls[key]!.owner!.terminal).not.toBe(first);
  });

  it("acts on the same state only once", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    await router.reconcilePull(repo, 7, "event");
    await router.reconcilePull(repo, 7, "sweep");
    expect(orca.prompts).toHaveLength(1);
  });

  it("only takes note of a PR the first time a sweep meets it", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.sweep();
    expect(orca.prompts).toHaveLength(0);
    // The base moving afterwards is news.
    github.behindBy = { by: 1, baseSha: "base1" };
    await router.sweep();
    expect(orca.prompts).toHaveLength(1);
    expect(orca.prompts[0]!.text).toContain("1 commit behind main");
  });

  it("wakes agents for PRs based on a branch that moved", async () => {
    github.pulls.set(7, pull());
    github.pulls.set(8, pull({ number: 8, baseRef: "other", headRef: "b8" }));
    github.behindBy = { by: 2, baseSha: "base1" };
    await router.reconcileBranch(repo, "main");
    expect(orca.prompts).toHaveLength(1);
    expect(orca.prompts[0]!.text).toContain("PR #7");
  });

  it("watches PRs the App's bot opened", async () => {
    github.pulls.set(7, { ...failing("sha1"), author: "ungood[bot]" });
    await router.reconcilePull(repo, 7, "event");
    expect(orca.prompts).toHaveLength(1);
  });

  it("ignores PRs from people outside the allowlist, and from forks", async () => {
    github.pulls.set(7, { ...failing("sha1"), author: "stranger" });
    github.pulls.set(8, { ...failing("sha1"), number: 8, fromFork: true });
    await router.reconcilePull(repo, 7, "event");
    await router.reconcilePull(repo, 8, "event");
    expect(orca.prompts).toHaveLength(0);
  });

  it("forgets a PR once it merges", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    github.pulls.set(7, { ...failing("sha1"), state: "MERGED" });
    await router.sweep();
    expect(store.state.pulls[key]).toBeUndefined();
  });

  it("runs a deterministic step for a route with `run`", async () => {
    const wp = { ...c.workplaces[0]! };
    wp.routes = { ...wp.routes, behind: { enabled: true, run: 'test "$BADBOT_SIGNAL" = behind' } };
    const r = { ...repo, path: tmpdir(), workplace: wp };
    github.pulls.set(7, pull());
    github.behindBy = { by: 1, baseSha: "base1" };
    await router.reconcilePull(r, 7, "event");
    expect(orca.prompts).toHaveLength(0);
    expect(store.state.pulls[key]!.handled).toContain("behind:aaaaaaa1111111:base1");
  });
});
