// Turns a PR's current state into Orca orchestration actions. Every entry
// point re-reads the PR from GitHub first: events only say where to look.

import { allRepos, type Config, type RepoConfig, type SignalKind } from "./config.js";
import { runShell } from "./exec.js";
import type { GitHub } from "./github/client.js";
import type { PullState } from "./github/pulls.js";
import type { Orca, Worktree } from "./orca/cli.js";
import { fill, signalsFor, type Signal } from "./signals.js";
import type { Owner, PullMemory, Store } from "./state.js";

export type Log = (message: string) => void;
export type Trigger = "event" | "sweep";

export const pullKey = (repo: string, number: number): string => `${repo.toLowerCase()}#${number}`;

export class Router {
  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly github: GitHub,
    private readonly orca: Orca,
    private readonly log: Log,
    // The command the router's own Orca terminal runs, so the user can watch it.
    private readonly coordinatorCommand: string,
    // The App's bot account (slug[bot]). PRs it opened are watched too.
    private readonly botLogin: string,
  ) {}

  // The router coordinates from a terminal of its own: Orca only lets a live
  // terminal own a Run. That terminal tails the daemon's log.
  async coordinator(): Promise<{ runId: string; handle: string }> {
    const orcaState = this.store.state.orca;
    const live = new Set((await this.orca.terminals()).map((t) => t.handle));
    if (!orcaState.coordinator || !live.has(orcaState.coordinator)) {
      const workplace = this.config.workplaces[0];
      if (!workplace) throw new Error("no workplaces configured");
      orcaState.coordinator = await this.orca.createTerminal(
        `path:${workplace.path}`,
        "badbot",
        this.coordinatorCommand,
      );
      if (orcaState.runId) {
        await this.orca.runUse(orcaState.runId, orcaState.coordinator);
      } else {
        orcaState.runId = await this.orca.runCreate(
          "badbot: wake the agent that owns a PR when something happens to it",
          orcaState.coordinator,
        );
      }
      await this.store.save();
      this.log(`coordinating Run ${orcaState.runId} from terminal ${orcaState.coordinator}`);
    }
    if (!orcaState.runId) throw new Error("no orchestration Run");
    return { runId: orcaState.runId, handle: orcaState.coordinator };
  }

  async reconcilePull(
    repo: RepoConfig,
    target: number | PullState,
    trigger: Trigger,
  ): Promise<void> {
    const number = typeof target === "number" ? target : target.number;
    const pull = typeof target === "number" ? await this.github.pull(repo.name, number) : target;
    const key = pullKey(repo.name, number);
    const pulls = this.store.state.pulls;
    let memory = pulls[key];

    if (!pull) return;
    if (pull.state !== "OPEN") {
      if (memory) await this.forget(key, memory, pull);
      return;
    }
    const workplace = repo.workplace;
    const author = pull.author.toLowerCase();
    const allowed =
      author === this.botLogin.toLowerCase() ||
      workplace.allow.some((a) => a.toLowerCase() === author);
    if (!allowed || pull.fromFork) return;

    const behind =
      pull.mergeable === "MERGEABLE"
        ? await this.github.behind(repo.name, pull.baseRef, pull.headSha)
        : undefined;
    const signals = signalsFor(pull, {
      allow: workplace.allow,
      since: this.store.state.startedAt,
      handled: new Set(memory?.handled ?? []),
      ...(behind && { behind }),
    }).filter((s) => workplace.routes[s.kind].enabled);

    if (!memory) {
      memory = { handled: [] };
      pulls[key] = memory;
      // A sweep that meets a PR for the first time only takes note of its
      // state. The router reacts to what changes after it starts watching.
      if (trigger === "sweep") {
        memory.handled.push(...signals.flatMap((s) => s.keys));
        await this.store.save();
        return;
      }
    }
    if (signals.length === 0) {
      await this.store.save();
      return;
    }

    const handled: Signal[] = [];
    const prompts: string[] = [];
    for (const signal of signals) {
      const route = workplace.routes[signal.kind];
      if (route.run && !(await this.runStep(repo, pull, signal, route.run))) continue;
      if (route.prompt) prompts.push(fill(route.prompt, pull, signal.details));
      handled.push(signal);
    }
    if (prompts.length > 0) {
      memory.owner = await this.wake(
        repo,
        pull,
        memory.owner,
        prompts,
        handled.map((s) => s.kind),
      );
    }
    memory.handled.push(...handled.flatMap((s) => s.keys));
    await this.store.save();
  }

  async reconcileBranch(repo: RepoConfig, branch: string): Promise<void> {
    for (const pull of await this.github.openPulls(repo.name)) {
      if (pull.baseRef === branch) await this.reconcilePull(repo, pull, "event");
    }
  }

  async sweep(): Promise<void> {
    for (const repo of allRepos(this.config)) {
      const open = await this.github.openPulls(repo.name);
      for (const pull of open) await this.reconcilePull(repo, pull, "sweep");
      // PRs the router remembers that have since closed or merged.
      const openKeys = new Set(open.map((p) => pullKey(repo.name, p.number)));
      for (const key of Object.keys(this.store.state.pulls)) {
        if (!key.startsWith(`${repo.name.toLowerCase()}#`) || openKeys.has(key)) continue;
        await this.reconcilePull(repo, Number(key.split("#")[1]), "sweep");
      }
    }
  }

  // Settlements and questions from the agents the router started.
  async drainRunInbox(): Promise<void> {
    const { runId, handle } = await this.coordinator();
    const { deliveryId, messages } = await this.orca.check(runId, handle);
    if (!deliveryId) return;
    for (const message of messages) {
      const dispatchId = message.payload.dispatchId as string | undefined;
      if (message.type === "worker_done" && dispatchId) {
        const owned = Object.values(this.store.state.pulls).some(
          (m) => m.owner?.dispatchId === dispatchId,
        );
        this.log(`${dispatchId} finished (${String(message.payload.outcome)}): ${message.subject}`);
        // Keep the agent's terminal for the PR's next event, so it resumes with its context.
        if (owned) await this.orca.retain(dispatchId);
        else await this.orca.release(dispatchId);
      } else if (message.type === "question") {
        this.log(`${dispatchId ?? "a worker"} asked: ${message.subject}`);
        await this.orca.reply(
          message.id,
          handle,
          "badbot is a router, not a person, and can't answer. If the safe choice is clear and " +
            "reversible, take it and say so on the PR. Otherwise explain the question in your terminal " +
            "for the user and send worker_done with --outcome failed.",
        );
      } else {
        this.log(`${message.type} from ${dispatchId ?? "a worker"}: ${message.subject}`);
      }
    }
    await this.orca.ack(runId, handle, deliveryId);
  }

  private async forget(key: string, memory: PullMemory, pull: PullState): Promise<void> {
    if (memory.owner?.startedAgent) {
      try {
        const info = await this.orca.workerShow(memory.owner.dispatchId);
        if (info.settled) await this.orca.release(memory.owner.dispatchId);
      } catch (error) {
        this.log(`couldn't release ${memory.owner.dispatchId}: ${String(error)}`);
      }
    }
    Reflect.deleteProperty(this.store.state.pulls, key);
    await this.store.save();
    this.log(`${pull.url} is ${pull.state.toLowerCase()}; stopped watching it`);
  }

  private async runStep(
    repo: RepoConfig,
    pull: PullState,
    signal: Signal,
    command: string,
  ): Promise<boolean> {
    const { code, output } = await runShell(command, {
      cwd: repo.path,
      env: {
        ...process.env,
        BADBOT_SIGNAL: signal.kind,
        BADBOT_REPO: pull.repo,
        BADBOT_PR: String(pull.number),
        BADBOT_URL: pull.url,
        BADBOT_BRANCH: pull.headRef,
        BADBOT_BASE: pull.baseRef,
        BADBOT_HEAD: pull.headSha,
        BADBOT_DETAILS: signal.details,
      },
    });
    this.log(
      `${pull.url}: ran \`${command}\` for ${signal.kind}: exit ${code}${output ? `\n${output.trimEnd()}` : ""}`,
    );
    return code === 0;
  }

  private async wake(
    repo: RepoConfig,
    pull: PullState,
    owner: Owner | undefined,
    prompts: string[],
    kinds: SignalKind[],
  ): Promise<Owner> {
    const { runId, handle } = await this.coordinator();
    const what = kinds.join(", ").replaceAll("_", " ");
    const news = prompts.join("\n\n---\n\n");
    const terminals = await this.orca.terminals();
    const live = new Set(terminals.map((t) => t.handle));

    if (owner) {
      const info = await this.orca.workerShow(owner.dispatchId).catch(() => undefined);
      if (info && !info.settled && info.terminal && live.has(info.terminal)) {
        // The owner is still working: steer it rather than start another agent.
        await this.orca.send(runId, handle, owner.dispatchId, `${what} on ${pull.url}`, news);
        this.log(`${pull.url}: ${what}: sent to working agent ${owner.dispatchId}`);
        return owner;
      }
      if (info?.settled && info.terminal && live.has(info.terminal)) {
        const worktreeId = info.worktreeId ?? owner.worktreeId;
        const dispatchId = await this.orca.workerStart(runId, handle, {
          spec: this.spec(pull, news, undefined),
          worktreeId,
          terminal: info.terminal,
          title: `${what}: ${pull.repo}#${pull.number}`,
        });
        this.log(`${pull.url}: ${what}: resumed the same agent as ${dispatchId}`);
        return { dispatchId, worktreeId, startedAgent: owner.startedAgent };
      }
    }

    // Nobody owns the PR yet. Adopt the agent already working in the PR's
    // worktree if there is one, so it keeps its context.
    const worktree =
      (await this.worktreeFor(repo, pull)) ?? (await this.createWorktreeFor(repo, pull));
    const agent = terminals.find(
      (t) =>
        t.worktreeId === worktree.id &&
        t.agentIdentity === repo.workplace.agent &&
        t.handle !== handle,
    );
    const dispatchId = await this.orca.workerStart(runId, handle, {
      spec: this.spec(pull, news, worktree),
      worktreeId: worktree.id,
      agent: repo.workplace.agent,
      title: `${what}: ${pull.repo}#${pull.number}`,
      ...(agent && { terminal: agent.handle }),
    });
    this.log(
      `${pull.url}: ${what}: ${agent ? `handed to the agent in ${worktree.path}` : `started an agent in ${worktree.path}`} as ${dispatchId}`,
    );
    return { dispatchId, worktreeId: worktree.id, startedAgent: !agent };
  }

  private spec(pull: PullState, news: string, worktree: Worktree | undefined): string {
    const onBranch = !worktree || worktree.branch === `refs/heads/${pull.headRef}`;
    return [
      `badbot: ${pull.repo} PR #${pull.number}, "${pull.title}" (${pull.url}), branch ${pull.headRef}.`,
      news,
      "You own this PR." +
        (onBranch ? "" : ` First check out its branch with \`gh pr checkout ${pull.number}\`.`) +
        " When you're done, send worker_done as your preamble says.",
    ].join("\n\n");
  }

  private async worktreeFor(repo: RepoConfig, pull: PullState): Promise<Worktree | undefined> {
    const repoId = await this.orca.repoId(repo.path);
    if (!repoId) throw new Error(`${repo.path} isn't an Orca repo; add it with \`orca repo add\``);
    const worktrees = await this.orca.worktrees();
    return worktrees.find(
      (w) => w.repoId === repoId && !w.isArchived && w.branch === `refs/heads/${pull.headRef}`,
    );
  }

  private async createWorktreeFor(repo: RepoConfig, pull: PullState): Promise<Worktree> {
    const name = pull.headRef.replace(/[^\w.-]+/g, "-");
    await this.orca.createWorktree(repo.path, name, pull.number);
    const repoId = await this.orca.repoId(repo.path);
    const worktrees = (await this.orca.worktrees()).filter(
      (w) => w.repoId === repoId && !w.isArchived,
    );
    const created =
      worktrees.find((w) => w.branch === `refs/heads/${pull.headRef}`) ??
      worktrees.find((w) => w.path.endsWith(`/${name}`));
    if (!created) throw new Error(`created a worktree for ${pull.url} but can't find it`);
    return created;
  }
}
