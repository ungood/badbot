// The daemon's memory, kept as one JSON file and replaced atomically.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "./paths.js";

export interface Owner {
  worktreeId: string;
  // The agent terminal badbot last prompted, reused while it's open.
  terminal: string;
}

export interface PullMemory {
  // Signal keys already acted on, so a sweep or a duplicate event never
  // wakes the agent twice for the same thing.
  handled: string[];
  owner?: Owner;
}

export interface State {
  version: 1;
  // Feedback older than this predates the router and is never acted on.
  startedAt: string;
  inbox: { url?: string };
  pulls: Record<string, PullMemory>;
  seenDeliveries: string[];
  // GitHub delivery GUIDs the sweep has already asked GitHub to redeliver.
  redelivered: string[];
}

const MAX_HANDLED = 200;
const MAX_SEEN = 2000;

export function emptyState(now = new Date()): State {
  return {
    version: 1,
    startedAt: now.toISOString(),
    inbox: {},
    pulls: {},
    seenDeliveries: [],
    redelivered: [],
  };
}

export class Store {
  constructor(
    public state: State,
    private readonly file: string,
  ) {}

  static async open(dir = stateDir()): Promise<Store> {
    const file = join(dir, "state.json");
    try {
      return new Store(JSON.parse(await readFile(file, "utf8")) as State, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(dir, { recursive: true });
      const store = new Store(emptyState(), file);
      await store.save();
      return store;
    }
  }

  async save(): Promise<void> {
    const s = this.state;
    s.seenDeliveries = s.seenDeliveries.slice(-MAX_SEEN);
    s.redelivered = s.redelivered.slice(-MAX_SEEN);
    for (const memory of Object.values(s.pulls))
      memory.handled = memory.handled.slice(-MAX_HANDLED);
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(s, null, 2) + "\n");
    await rename(tmp, this.file);
  }
}
