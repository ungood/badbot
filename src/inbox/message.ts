// What the inbox queues. Only a reference: the daemon re-reads the entity's
// real state from its source before acting, so events are hints.

export type Entity =
  | { kind: "pull"; repo: string; number: number }
  | { kind: "issue"; repo: string; number: number }
  // A branch moved. PRs based on it may now be behind or conflicted.
  | { kind: "branch"; repo: string; branch: string };

export interface InboxMessage {
  source: "github";
  deliveryId: string;
  event: string;
  entity: Entity;
  receivedAt: string;
}

export function entityKey(entity: Entity): string {
  switch (entity.kind) {
    case "pull":
    case "issue":
      return `${entity.repo}#${entity.number}`;
    case "branch":
      return `${entity.repo}@${entity.branch}`;
  }
}

export function isInboxMessage(value: unknown): value is InboxMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  const e = m.entity as Record<string, unknown> | undefined;
  return (
    m.source === "github" &&
    typeof m.deliveryId === "string" &&
    typeof m.event === "string" &&
    typeof e === "object" &&
    e !== null &&
    typeof e.repo === "string" &&
    (((e.kind === "pull" || e.kind === "issue") && typeof e.number === "number") ||
      (e.kind === "branch" && typeof e.branch === "string"))
  );
}
