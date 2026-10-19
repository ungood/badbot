// Decides what about a PR needs its agent's attention, from the PR's current
// state alone. Each signal carries keys, and a key the router has already
// acted on never fires again, so sweeps and duplicate events are harmless.

import type { Behind } from "./github/client.js";
import type { PullState } from "./github/pulls.js";
import type { SignalKind } from "./config.js";

export interface Signal {
  kind: SignalKind;
  keys: string[];
  details: string;
}

export interface SignalContext {
  allow: string[];
  // Feedback from before this time is never acted on.
  since: string;
  handled: ReadonlySet<string>;
  // Absent when the PR conflicts or GitHub hasn't computed mergeability yet.
  behind?: Behind;
}

function quote(text: string, max = 600): string {
  const trimmed = text.trim();
  const short = trimmed.length > max ? trimmed.slice(0, max) + "…" : trimmed;
  return short
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

export function signalsFor(pull: PullState, ctx: SignalContext): Signal[] {
  const signals: Signal[] = [];
  const allow = new Set(ctx.allow.map((a) => a.toLowerCase()));

  const feedback = pull.feedback.filter(
    (f) =>
      allow.has(f.author.toLowerCase()) &&
      f.createdAt >= ctx.since &&
      !ctx.handled.has(`review:${f.id}`),
  );
  if (feedback.length > 0) {
    signals.push({
      kind: "review",
      keys: feedback.map((f) => `review:${f.id}`),
      details: feedback
        .map((f) => `- ${f.author} on ${f.where} (${f.url}):\n${quote(f.body)}`)
        .join("\n\n"),
    });
  }

  const ciKey = `ci:${pull.headSha}`;
  if (pull.checks.failing.length > 0 && !ctx.handled.has(ciKey)) {
    signals.push({
      kind: "ci_failed",
      keys: [ciKey],
      details: pull.checks.failing
        .map((c) => `- ${c.name}${c.url ? ` (${c.url})` : ""}`)
        .join("\n"),
    });
  }

  if (pull.mergeable === "CONFLICTING") {
    const key = `conflicted:${pull.headSha}`;
    if (!ctx.handled.has(key)) signals.push({ kind: "conflicted", keys: [key], details: "" });
  } else if (ctx.behind && ctx.behind.by > 0) {
    // Keyed by the base's tip, so each move of the base fires once.
    const key = `behind:${pull.headSha}:${ctx.behind.baseSha}`;
    if (!ctx.handled.has(key)) {
      const commits = ctx.behind.by === 1 ? "1 commit" : `${ctx.behind.by} commits`;
      signals.push({ kind: "behind", keys: [key], details: `${commits} behind ${pull.baseRef}` });
    }
  }

  return signals;
}

export function fill(template: string, pull: PullState, details: string): string {
  const values: Record<string, string> = {
    repo: pull.repo,
    number: String(pull.number),
    url: pull.url,
    title: pull.title,
    branch: pull.headRef,
    base: pull.baseRef,
    head: pull.headSha.slice(0, 7),
    details,
  };
  return template.replace(/\{(\w+)\}/g, (match, name: string) => values[name] ?? match);
}
