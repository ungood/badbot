import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { GitHub } from "../src/github/client.js";
import type { PullState } from "../src/github/pulls.js";
import type {
  Orca,
  RunMessage,
  Terminal,
  WorkerInfo,
  WorkerStart,
  Worktree,
} from "../src/orca/cli.js";
import { pullKey, Router } from "../src/router.js";
import { Store } from "../src/state.js";
import { config, pull, repoOf } from "./fixtures.js";

class FakeOrca {
  terminalList: Terminal[] = [];
  worktreeList: Worktree[] = [
    { id: "r1::/work", repoId: "r1", path: "/work", branch: "refs/heads/main", isArchived: false },
  ];
  workers = new Map<string, WorkerInfo>();
  started: WorkerStart[] = [];
  sent: { dispatchId: string; body: string }[] = [];
  created: string[] = [];
  inbox: { deliveryId: string | null; messages: RunMessage[] } = { deliveryId: null, messages: [] };
  calls: string[] = [];
  private next = 1;

  async terminals() {
    return this.terminalList;
  }
  async createTerminal(_worktree: string, _title: string, _command: string) {
    const handle = `term_coord${this.next++}`;
    this.terminalList.push({ handle, worktreeId: "r1::/work" });
    return handle;
  }
  async runCreate() {
    return "run_1";
  }
  async runUse(runId: string, from: string) {
    this.calls.push(`run-use ${runId} ${from}`);
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
  async workerStart(_run: string, _from: string, w: WorkerStart) {
    this.started.push(w);
    const dispatchId = `ctx_${this.next++}`;
    const terminal = w.terminal ?? `term_agent${this.next++}`;
    if (!w.terminal)
      this.terminalList.push({
        handle: terminal,
        worktreeId: w.worktreeId,
        agentIdentity: "claude",
      });
    this.workers.set(dispatchId, {
      dispatchId,
      status: "running",
      settled: false,
      terminal,
      worktreeId: w.worktreeId,
    });
    return dispatchId;
  }
  async workerShow(dispatchId: string) {
    const info = this.workers.get(dispatchId);
    if (!info) throw new Error("unknown dispatch");
    return info;
  }
  async send(_run: string, _from: string, dispatchId: string, _subject: string, body: string) {
    this.sent.push({ dispatchId, body });
  }
  async check() {
    return this.inbox;
  }
  async ack(_run: string, _t: string, deliveryId: string) {
    this.calls.push(`ack ${deliveryId}`);
    this.inbox = { deliveryId: null, messages: [] };
  }
  async reply(id: string) {
    this.calls.push(`reply ${id}`);
  }
  async retain(id: string) {
    this.calls.push(`retain ${id}`);
  }
  async release(id: string) {
    this.calls.push(`release ${id}`);
  }
  settle(dispatchId: string) {
    this.workers.get(dispatchId)!.settled = true;
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
  const lines: string[] = [];

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
      (l) => lines.push(l),
      "tail",
      "ungood[bot]",
    );
  });

  it("starts an agent in a new worktree when nobody has the PR's branch", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    expect(orca.created).toEqual(["ungood-thing"]);
    expect(orca.started).toHaveLength(1);
    expect(orca.started[0]).toMatchObject({ worktreeId: "r1::/wt/ungood-thing", agent: "claude" });
    expect(orca.started[0]!.terminal).toBeUndefined();
    // The new worktree isn't on the PR's branch yet.
    expect(orca.started[0]!.spec).toContain("gh pr checkout 7");
    expect(store.state.pulls[pullKey("ungood/factory", 7)]?.owner?.startedAgent).toBe(true);
  });

  it("adopts the agent already working in the PR's worktree", async () => {
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
    expect(orca.started[0]).toMatchObject({ worktreeId: "r1::/wt/x", terminal: "term_mine" });
    expect(orca.started[0]!.spec).not.toContain("gh pr checkout");
    expect(store.state.pulls[pullKey("ungood/factory", 7)]?.owner?.startedAgent).toBe(false);
  });

  it("steers a busy owner, then resumes the same terminal once it has settled", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    const first = store.state.pulls[pullKey("ungood/factory", 7)]!.owner!.dispatchId;

    github.pulls.set(7, failing("sha2"));
    await router.reconcilePull(repo, 7, "event");
    expect(orca.sent).toEqual([
      { dispatchId: first, body: expect.stringContaining("Checks failed") },
    ]);
    expect(orca.started).toHaveLength(1);

    orca.settle(first);
    const terminal = orca.workers.get(first)!.terminal;
    github.pulls.set(7, failing("sha3"));
    await router.reconcilePull(repo, 7, "event");
    expect(orca.started).toHaveLength(2);
    expect(orca.started[1]!.terminal).toBe(terminal);
    expect(store.state.pulls[pullKey("ungood/factory", 7)]!.owner!.dispatchId).not.toBe(first);
  });

  it("acts on the same state only once", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    await router.reconcilePull(repo, 7, "event");
    await router.reconcilePull(repo, 7, "sweep");
    expect(orca.started).toHaveLength(1);
    expect(orca.sent).toHaveLength(0);
  });

  it("only takes note of a PR the first time a sweep meets it", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.sweep();
    expect(orca.started).toHaveLength(0);
    // The base moving afterwards is news.
    github.behindBy = { by: 1, baseSha: "base1" };
    await router.sweep();
    expect(orca.started).toHaveLength(1);
    expect(orca.started[0]!.spec).toContain("1 commit behind main");
  });

  it("wakes agents for PRs based on a branch that moved", async () => {
    github.pulls.set(7, pull());
    github.pulls.set(8, pull({ number: 8, baseRef: "other", headRef: "b8" }));
    github.behindBy = { by: 2, baseSha: "base1" };
    await router.reconcileBranch(repo, "main");
    expect(orca.started).toHaveLength(1);
    expect(orca.started[0]!.title).toContain("#7");
  });

  it("watches PRs the App's bot opened", async () => {
    github.pulls.set(7, { ...failing("sha1"), author: "ungood[bot]" });
    await router.reconcilePull(repo, 7, "event");
    expect(orca.started).toHaveLength(1);
  });

  it("ignores PRs from people outside the allowlist, and from forks", async () => {
    github.pulls.set(7, { ...failing("sha1"), author: "stranger" });
    github.pulls.set(8, { ...failing("sha1"), number: 8, fromFork: true });
    await router.reconcilePull(repo, 7, "event");
    await router.reconcilePull(repo, 8, "event");
    expect(orca.started).toHaveLength(0);
  });

  it("releases an agent it started once the PR merges", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    const owner = store.state.pulls[pullKey("ungood/factory", 7)]!.owner!;
    orca.settle(owner.dispatchId);
    github.pulls.set(7, { ...failing("sha1"), state: "MERGED" });
    await router.sweep();
    expect(orca.calls).toContain(`release ${owner.dispatchId}`);
    expect(store.state.pulls[pullKey("ungood/factory", 7)]).toBeUndefined();
  });

  it("runs a deterministic step for a route with `run`", async () => {
    const wp = { ...c.workplaces[0]! };
    wp.routes = {
      ...wp.routes,
      behind: { enabled: true, run: 'test "$BADBOT_SIGNAL" = behind' },
    };
    const r = { ...repo, path: tmpdir(), workplace: wp };
    github.pulls.set(7, pull());
    github.behindBy = { by: 1, baseSha: "base1" };
    await router.reconcilePull(r, 7, "event");
    expect(orca.started).toHaveLength(0);
    expect(store.state.pulls[pullKey("ungood/factory", 7)]!.handled).toContain(
      "behind:aaaaaaa1111111:base1",
    );
  });

  it("keeps an owner's terminal when it settles, and answers questions", async () => {
    github.pulls.set(7, failing("sha1"));
    await router.reconcilePull(repo, 7, "event");
    const owner = store.state.pulls[pullKey("ungood/factory", 7)]!.owner!;
    orca.inbox = {
      deliveryId: "delivery_1",
      messages: [
        {
          id: "m1",
          type: "worker_done",
          subject: "done",
          body: "",
          payload: { dispatchId: owner.dispatchId, outcome: "succeeded" },
        },
        {
          id: "m2",
          type: "question",
          subject: "which?",
          body: "",
          payload: { dispatchId: owner.dispatchId },
        },
        {
          id: "m3",
          type: "worker_done",
          subject: "done",
          body: "",
          payload: { dispatchId: "ctx_other", outcome: "failed" },
        },
      ],
    };
    await router.drainRunInbox();
    expect(orca.calls).toEqual(
      expect.arrayContaining([
        `retain ${owner.dispatchId}`,
        "reply m2",
        "release ctx_other",
        "ack delivery_1",
      ]),
    );
  });

  it("recreates its coordinator terminal and rebinds the Run when the old one is gone", async () => {
    await router.coordinator();
    orca.terminalList = [];
    const { handle } = await router.coordinator();
    expect(orca.calls).toContain(`run-use run_1 ${handle}`);
  });
});
