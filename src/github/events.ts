// Maps a GitHub webhook delivery to the entities it touches. Shared by the
// Worker and the daemon, so it uses no Node or Workers APIs.

import type { Entity } from "../inbox/message.js";

type Payload = Record<string, unknown>;

function obj(value: unknown): Payload | undefined {
  return typeof value === "object" && value !== null ? (value as Payload) : undefined;
}

function pullNumbers(list: unknown): number[] {
  if (!Array.isArray(list)) return [];
  return list.map((p) => obj(p)?.number).filter((n): n is number => typeof n === "number");
}

export function entitiesFor(event: string, payload: unknown): Entity[] {
  const body = obj(payload);
  const repo = obj(body?.repository)?.full_name;
  if (typeof repo !== "string") return [];
  const pull = (number: unknown): Entity[] =>
    typeof number === "number" ? [{ kind: "pull", repo, number }] : [];

  switch (event) {
    case "pull_request":
    case "pull_request_review":
    case "pull_request_review_comment":
    case "pull_request_review_thread":
      return pull(obj(body?.pull_request)?.number);
    case "issue_comment":
    case "issues": {
      const issue = obj(body?.issue);
      const number = issue?.number;
      if (typeof number !== "number") return [];
      // GitHub sends PR conversation comments as issue comments.
      return issue?.pull_request ? pull(number) : [{ kind: "issue", repo, number }];
    }
    case "check_suite":
      if (obj(body?.check_suite)?.status !== "completed") return [];
      return pullNumbers(obj(body?.check_suite)?.pull_requests).flatMap(pull);
    case "workflow_run":
      if (obj(body?.workflow_run)?.status !== "completed") return [];
      return pullNumbers(obj(body?.workflow_run)?.pull_requests).flatMap(pull);
    case "push": {
      const ref = body?.ref;
      if (typeof ref !== "string" || !ref.startsWith("refs/heads/") || body?.deleted === true) {
        return [];
      }
      return [{ kind: "branch", repo, branch: ref.slice("refs/heads/".length) }];
    }
    default:
      return [];
  }
}
