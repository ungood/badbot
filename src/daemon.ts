// The daemon's loop. Every poll it drains the inbox queue. On wake from
// sleep, and every sweep interval, it also reconciles every PR from GitHub's
// API and asks GitHub to redeliver failed webhooks.

import { allRepos, findRepo, type Config } from "./config.js";
import { failedDeliveries, type GitHub } from "./github/client.js";
import { entityKey, type InboxMessage } from "./inbox/message.js";
import type { CloudflareQueue } from "./inbox/queue.js";
import type { Log, Router } from "./router.js";
import type { Store } from "./state.js";

const GITHUB_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

export class Daemon {
  private lastTick = 0;
  private lastSweep = 0;
  private stopped = false;

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly router: Router,
    private readonly github: GitHub,
    private readonly queue: CloudflareQueue | undefined,
    private readonly log: Log,
    private readonly now: () => number = Date.now,
  ) {}

  async tick(forceSweep = false): Promise<void> {
    const now = this.now();
    // A gap much longer than the poll interval means the laptop slept.
    const woke = this.lastTick > 0 && now - this.lastTick > 3 * this.config.pollSeconds * 1000;
    this.lastTick = now;
    if (woke) this.log("woke from sleep; sweeping");

    await this.step("inbox", () => this.drainQueue());
    if (forceSweep || woke || now - this.lastSweep >= this.config.sweepSeconds * 1000) {
      this.lastSweep = now;
      await this.step("sweep", () => this.router.sweep());
      await this.step("redelivery", () => this.redeliverFailed());
    }
  }

  async run(): Promise<void> {
    this.log(
      `watching ${allRepos(this.config)
        .map((r) => r.name)
        .join(", ")}`,
    );
    const stop = () => {
      this.stopped = true;
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    while (!this.stopped) {
      await this.tick();
      await new Promise((resolve) => setTimeout(resolve, this.config.pollSeconds * 1000));
    }
    this.log("stopped");
  }

  private async step(name: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.log(`${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async drainQueue(): Promise<void> {
    if (!this.queue) return;
    for (;;) {
      const batch = await this.queue.pull();
      if (batch.length === 0) return;
      const acks: string[] = [];
      const retries: string[] = [];
      for (const leased of batch) {
        try {
          if (leased.message) await this.handle(leased.message);
          acks.push(leased.leaseId);
        } catch (error) {
          this.log(
            `will retry ${leased.message ? entityKey(leased.message.entity) : "a message"}: ${String(error)}`,
          );
          retries.push(leased.leaseId);
        }
      }
      await this.queue.settle(acks, retries);
      if (retries.length > 0) return;
    }
  }

  private async handle(message: InboxMessage): Promise<void> {
    const seen = this.store.state.seenDeliveries;
    const id = `${message.deliveryId}:${entityKey(message.entity)}`;
    if (seen.includes(id)) return;
    const repo = findRepo(this.config, message.entity.repo);
    if (repo) {
      const entity = message.entity;
      if (entity.kind === "pull") await this.router.reconcilePull(repo, entity.number, "event");
      else if (entity.kind === "branch") await this.router.reconcileBranch(repo, entity.branch);
      // Issues aren't routed yet.
    }
    seen.push(id);
    await this.store.save();
  }

  async redeliverFailed(): Promise<void> {
    if (!this.store.state.inbox.url) return;
    const since = new Date(
      Math.max(this.now() - GITHUB_RETENTION_MS, Date.parse(this.store.state.startedAt)),
    );
    const done = new Set(this.store.state.redelivered);
    const failed = failedDeliveries(await this.github.recentDeliveries(since));
    for (const delivery of failed.filter((d) => !done.has(d.guid))) {
      await this.github.redeliver(delivery.id);
      this.store.state.redelivered.push(delivery.guid);
      this.log(`asked GitHub to redeliver ${delivery.guid} from ${delivery.deliveredAt}`);
    }
    await this.store.save();
  }
}
