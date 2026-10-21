// Turns a PR's current state into Orca actions. Every entry point re-reads
// the PR from GitHub first: events only say where to look. badbot doesn't
// supervise agents. It hands the PR to the agent in the PR's worktree and
// judges progress by what it can see on GitHub.

import { allRepos, type Config, type RepoConfig, type SignalKind } from "./config.js";
import { runShell } from "./exec.js";
import type { GitHub } from "./github/client.js";
import type { PullState } from "./github/pulls.js";
import type { Orca, Worktree } from "./orca/cli.js";
import { fill, signalsFor, type Signal } from "./signals.js";
import type { Owner, Store } from "./state.js";

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
    // The App's bot account (slug[bot]). PRs it opened are watched too.
    private readonly botLogin: string,
  ) {}

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
      if (memory) {
        Reflect.deleteProperty(pulls, key);
        await this.store.save();
        this.log(`${pull.url} is ${pull.state.toLowerCase()}; stopped watching it`);
      }
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
    const what = kinds.join(", ").replaceAll("_", " ");
    const terminals = await this.orca.terminals();
    const live = new Set(terminals.map((t) => t.handle));

    // The agent badbot last prompted is still open: tell it. If it's busy, it
    // reads the message when it finishes its turn.
    if (owner && live.has(owner.terminal)) {
      await this.orca.prompt(owner.terminal, this.message(pull, prompts, undefined));
      this.log(`${pull.url}: ${what}: told the agent in its worktree`);
      return owner;
    }

    const worktree =
      (await this.worktreeFor(repo, pull, owner?.worktreeId)) ??
      (await this.createWorktreeFor(repo, pull));
    // An agent you already have open in the PR's worktree keeps its context.
    const existing = terminals.find(
      (t) => t.worktreeId === worktree.id && t.agentIdentity === repo.workplace.agent,
    );
    const terminal =
      existing?.handle ??
      (await this.orca.startAgent(
        worktree.id,
        repo.workplace.agentCommand,
        `badbot: ${pull.repo}#${pull.number}`,
      ));
    await this.orca.prompt(terminal, this.message(pull, prompts, worktree));
    this.log(
      `${pull.url}: ${what}: ${existing ? "told the agent" : "started an agent"} in ${worktree.path}`,
    );
    return { worktreeId: worktree.id, terminal };
  }

  private message(pull: PullState, prompts: string[], worktree: Worktree | undefined): string {
    const onBranch = !worktree || worktree.branch === `refs/heads/${pull.headRef}`;
    return [
      `badbot: ${pull.repo} PR #${pull.number}, "${pull.title}" (${pull.url}), branch ${pull.headRef}.`,
      ...(onBranch
        ? []
        : [`First check out the PR's branch with \`gh pr checkout ${pull.number}\`.`]),
      prompts.join("\n\n---\n\n"),
    ].join("\n\n");
  }

  // The worktree badbot used for this PR before, else any worktree on the PR's branch.
  private async worktreeFor(
    repo: RepoConfig,
    pull: PullState,
    remembered: string | undefined,
  ): Promise<Worktree | undefined> {
    const repoId = await this.orca.repoId(repo.path);
    if (!repoId) throw new Error(`${repo.path} isn't an Orca repo; add it with \`orca repo add\``);
    const worktrees = (await this.orca.worktrees()).filter(
      (w) => w.repoId === repoId && !w.isArchived,
    );
    return (
      worktrees.find((w) => w.id === remembered) ??
      worktrees.find((w) => w.branch === `refs/heads/${pull.headRef}`)
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
