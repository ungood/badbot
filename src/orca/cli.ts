// A thin wrapper over the `orca` CLI's JSON output. badbot only uses
// worktrees and terminals: it hands a PR to the agent in its worktree, and
// doesn't supervise it.

import { execFileAsync } from "../exec.js";

export class OrcaError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`orca: ${code}: ${message}`);
  }
}

type Json = Record<string, unknown>;

export interface Terminal {
  handle: string;
  worktreeId: string;
  agentIdentity?: string;
}

export interface Worktree {
  id: string;
  repoId: string;
  path: string;
  branch: string;
  isArchived: boolean;
}

export class Orca {
  constructor(private readonly bin = "orca") {}

  async call(args: string[]): Promise<Json> {
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(this.bin, [...args, "--json"], {
        maxBuffer: 32 * 1024 * 1024,
      }));
    } catch (error) {
      // orca exits non-zero with a JSON error on stdout.
      stdout = (error as { stdout?: string }).stdout ?? "";
      if (!stdout.trim()) throw error;
    }
    const reply = JSON.parse(stdout) as {
      ok: boolean;
      result?: Json;
      error?: { code: string; message: string };
    };
    if (!reply.ok) {
      throw new OrcaError(reply.error?.code ?? "unknown", reply.error?.message ?? stdout);
    }
    return reply.result ?? {};
  }

  async terminals(): Promise<Terminal[]> {
    const result = await this.call(["terminal", "list"]);
    return (result.terminals as Terminal[]) ?? [];
  }

  async repoId(path: string): Promise<string | undefined> {
    const result = await this.call(["repo", "list"]);
    return ((result.repos as { id: string; path: string }[]) ?? []).find((r) => r.path === path)
      ?.id;
  }

  async worktrees(): Promise<Worktree[]> {
    const result = await this.call(["worktree", "list"]);
    return (result.worktrees as Worktree[]) ?? [];
  }

  async createWorktree(repoPath: string, name: string, pr: number): Promise<void> {
    await this.call([
      "worktree",
      "create",
      "--repo",
      `path:${repoPath}`,
      "--name",
      name,
      "--pr",
      String(pr),
      "--no-parent",
    ]);
  }

  // Starts an agent in a new terminal in the worktree and waits until it's ready for a prompt.
  async startAgent(worktreeId: string, command: string, title: string): Promise<string> {
    const result = await this.call([
      "terminal",
      "create",
      "--worktree",
      `id:${worktreeId}`,
      "--title",
      title,
      "--command",
      command,
    ]);
    const handle = (result.terminal as Json | undefined)?.handle ?? result.handle;
    if (typeof handle !== "string") {
      throw new OrcaError("unexpected_reply", "terminal create returned no handle");
    }
    await this.call([
      "terminal",
      "wait",
      "--terminal",
      handle,
      "--for",
      "tui-idle",
      "--timeout-ms",
      "120000",
    ]);
    return handle;
  }

  // Types a prompt into the agent and presses Enter. A busy agent queues it.
  async prompt(terminal: string, text: string): Promise<void> {
    await this.call(["terminal", "send", "--terminal", terminal, "--text", text, "--enter"]);
  }
}
