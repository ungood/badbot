// A thin wrapper over the `orca` CLI's JSON output.

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

export interface WorkerStart {
  spec: string;
  worktreeId: string;
  // Reuse this agent terminal, keeping the agent's session, instead of starting a new agent.
  terminal?: string;
  agent?: string;
  title?: string;
}

export interface WorkerInfo {
  dispatchId: string;
  status: string;
  settled: boolean;
  terminal?: string;
  worktreeId?: string;
}

export interface RunMessage {
  id: string;
  type: string;
  subject: string;
  body: string;
  payload: Json;
}

const SETTLED = new Set([
  "completed",
  "failed",
  "cancelled",
  "canceled",
  "abandoned",
  "stopped",
  "released",
]);

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
    if (!reply.ok)
      throw new OrcaError(reply.error?.code ?? "unknown", reply.error?.message ?? stdout);
    return reply.result ?? {};
  }

  async terminals(): Promise<Terminal[]> {
    const result = await this.call(["terminal", "list"]);
    return (result.terminals as Terminal[]) ?? [];
  }

  async createTerminal(worktree: string, title: string, command: string): Promise<string> {
    const result = await this.call([
      "terminal",
      "create",
      "--worktree",
      worktree,
      "--title",
      title,
      "--command",
      command,
    ]);
    const handle = (result.terminal as Json | undefined)?.handle ?? result.handle;
    if (typeof handle !== "string")
      throw new OrcaError("unexpected_reply", "terminal create returned no handle");
    return handle;
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

  async runCreate(objective: string, from: string): Promise<string> {
    const result = await this.call([
      "orchestration",
      "run-create",
      "--objective",
      objective,
      "--from",
      from,
    ]);
    return (result.run as Json).id as string;
  }

  async runUse(runId: string, from: string): Promise<void> {
    await this.call(["orchestration", "run-use", "--id", runId, "--from", from]);
  }

  async workerStart(runId: string, from: string, w: WorkerStart): Promise<string> {
    const args = [
      "orchestration",
      "worker-start",
      "--run",
      runId,
      "--from",
      from,
      "--spec",
      w.spec,
    ];
    args.push("--worktree", `id:${w.worktreeId}`);
    if (w.terminal) args.push("--terminal", w.terminal);
    else args.push("--agent", w.agent ?? "claude");
    if (w.title) args.push("--task-title", w.title);
    const result = await this.call(args);
    return result.dispatchId as string;
  }

  async workerShow(dispatchId: string): Promise<WorkerInfo> {
    const result = await this.call(["orchestration", "worker-show", "--dispatch", dispatchId]);
    const dispatch = (result.dispatch as Json | undefined) ?? {};
    const worker = (result.worker as Json | undefined) ?? {};
    const status = String(dispatch.status ?? worker.state ?? "unknown");
    const terminal = (worker.agentTerminalHandle ?? dispatch.assigneeHandle) as string | undefined;
    const worktreeId = worker.worktreeId as string | undefined;
    return {
      dispatchId,
      status,
      settled: SETTLED.has(status) || worker.stage === "settled",
      ...(terminal && { terminal }),
      ...(worktreeId && { worktreeId }),
    };
  }

  async send(
    runId: string,
    from: string,
    dispatchId: string,
    subject: string,
    body: string,
  ): Promise<void> {
    await this.call([
      "orchestration",
      "send",
      "--run",
      runId,
      "--from",
      from,
      "--to",
      `dispatch:${dispatchId}`,
      "--subject",
      subject,
      "--body",
      body,
    ]);
  }

  // The oldest unacknowledged batch in the Run's inbox, without waiting.
  async check(
    runId: string,
    terminal: string,
  ): Promise<{ deliveryId: string | null; messages: RunMessage[] }> {
    const result = await this.call([
      "orchestration",
      "check",
      "--run",
      runId,
      "--terminal",
      terminal,
    ]);
    const messages = ((result.messages as Json[]) ?? []).map((m) => ({
      id: m.id as string,
      type: m.type as string,
      subject: (m.subject as string) ?? "",
      body: (m.body as string) ?? "",
      payload:
        typeof m.payload === "string"
          ? (JSON.parse(m.payload) as Json)
          : ((m.payload as Json) ?? {}),
    }));
    return { deliveryId: (result.deliveryId as string | null) ?? null, messages };
  }

  async ack(runId: string, terminal: string, deliveryId: string): Promise<void> {
    await this.call([
      "orchestration",
      "check",
      "--run",
      runId,
      "--terminal",
      terminal,
      "--ack",
      deliveryId,
    ]);
  }

  async reply(messageId: string, from: string, body: string): Promise<void> {
    await this.call(["orchestration", "reply", "--id", messageId, "--from", from, "--body", body]);
  }

  async retain(dispatchId: string): Promise<void> {
    await this.call(["orchestration", "worker-retain", "--dispatch", dispatchId]);
  }

  async release(dispatchId: string): Promise<void> {
    await this.call(["orchestration", "worker-release", "--dispatch", dispatchId]);
  }
}
