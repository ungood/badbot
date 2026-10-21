import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Daemon } from "../src/daemon.js";
import type { GitHub } from "../src/github/client.js";
import type { CloudflareQueue, Leased } from "../src/inbox/queue.js";
import type { Router } from "../src/router.js";
import { Store } from "../src/state.js";
import { config } from "./fixtures.js";

function setup(batches: Leased[][], fail = new Set<number>()) {
  const reconciled: string[] = [];
  const settled: { acks: string[]; retries: string[] }[] = [];
  let sweeps = 0;
  const router = {
    async reconcilePull(_r: unknown, n: number) {
      if (fail.has(n)) throw new Error("orca is closed");
      reconciled.push(`pull ${n}`);
    },
    async reconcileBranch(_r: unknown, b: string) {
      reconciled.push(`branch ${b}`);
    },
    async sweep() {
      sweeps++;
    },
  };
  const queue = {
    async pull() {
      return batches.shift() ?? [];
    },
    async settle(acks: string[], retries: string[]) {
      settled.push({ acks, retries });
    },
  };
  return { router, queue, reconciled, settled, sweeps: () => sweeps };
}

const leased = (
  lease: string,
  delivery: string,
  number: number,
  repo = "ungood/factory",
): Leased => ({
  leaseId: lease,
  attempts: 1,
  message: {
    source: "github",
    deliveryId: delivery,
    event: "x",
    entity: { kind: "pull", repo, number },
    receivedAt: "",
  },
});

describe("Daemon", () => {
  it("acts on each delivery once, acks it after acting, and retries failures", async () => {
    const store = await Store.open(await mkdtemp(join(tmpdir(), "badbot-test-")));
    const s = setup(
      [
        [
          leased("l1", "d1", 1),
          leased("l2", "d1", 1),
          leased("l3", "d2", 2),
          leased("l4", "d3", 3, "someone/else"),
        ],
      ],
      new Set([2]),
    );
    const log: string[] = [];
    let now = 1_000_000;
    const daemon = new Daemon(
      config(),
      store,
      s.router as unknown as Router,
      {} as GitHub,
      s.queue as unknown as CloudflareQueue,
      (l) => log.push(l),
      () => now,
    );
    await daemon.tick();
    expect(s.reconciled).toEqual(["pull 1"]);
    expect(s.settled).toEqual([{ acks: ["l1", "l2", "l4"], retries: ["l3"] }]);
    expect(s.sweeps()).toBe(1);

    // A normal poll later doesn't sweep; a long gap (sleep) does.
    now += 30_000;
    await daemon.tick();
    expect(s.sweeps()).toBe(1);
    now += 3_600_000;
    await daemon.tick();
    expect(s.sweeps()).toBe(2);
    expect(log).toContain("woke from sleep; sweeping");
  });
});
