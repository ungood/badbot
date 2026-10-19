// A PR's current state as the router sees it, normalized from GitHub's GraphQL API.

export interface Feedback {
  id: string;
  url: string;
  author: string;
  body: string;
  createdAt: string;
  // Where it was left, for the agent: "review", "comment", or a file path.
  where: string;
}

export interface FailingCheck {
  name: string;
  url: string | null;
}

export interface PullState {
  repo: string;
  number: number;
  url: string;
  title: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  // The head branch lives in a fork.
  fromFork: boolean;
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  checks: { state: string | null; failing: FailingCheck[] };
  feedback: Feedback[];
}

export const PULL_FIELDS = `
  number url title state
  author { __typename login }
  headRefName headRefOid baseRefName mergeable isCrossRepository
  commits(last: 1) { nodes { commit { statusCheckRollup {
    state
    contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name conclusion detailsUrl }
      ... on StatusContext { context state targetUrl }
    } }
  } } } }
  comments(last: 50) { nodes { id url body createdAt author { __typename login } } }
  reviews(last: 50) { nodes { id url body state submittedAt author { __typename login } } }
  reviewThreads(last: 50) { nodes { isResolved path comments(last: 20) { nodes {
    id url body createdAt author { __typename login }
  } } } }
`;

interface Node {
  [key: string]: unknown;
}

// GraphQL drops the "[bot]" suffix from bot logins, so a GitHub App named like a
// user (ungood and ungood[bot]) would be indistinguishable without this.
const login = (n: unknown): string => {
  const actor = n as Node | null;
  const name = (actor?.login as string | undefined) ?? "ghost";
  return actor?.__typename === "Bot" ? `${name}[bot]` : name;
};
const nodes = (conn: unknown): Node[] =>
  ((conn as { nodes?: Node[] } | null)?.nodes ?? []).filter(Boolean);

const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
  "CANCELLED",
]);
const FAILED_STATES = new Set(["FAILURE", "ERROR"]);

export function normalizePull(repo: string, raw: Node): PullState {
  const rollup = nodes(raw.commits)[0]?.commit as Node | undefined;
  const status = rollup?.statusCheckRollup as Node | null | undefined;
  const failing: FailingCheck[] = [];
  for (const ctx of nodes(status?.contexts)) {
    if (ctx.__typename === "CheckRun" && FAILED_CONCLUSIONS.has(ctx.conclusion as string)) {
      failing.push({ name: ctx.name as string, url: (ctx.detailsUrl as string) ?? null });
    } else if (ctx.__typename === "StatusContext" && FAILED_STATES.has(ctx.state as string)) {
      failing.push({ name: ctx.context as string, url: (ctx.targetUrl as string) ?? null });
    }
  }

  const feedback: Feedback[] = [];
  for (const c of nodes(raw.comments)) {
    feedback.push({
      id: c.id as string,
      url: c.url as string,
      author: login(c.author),
      body: c.body as string,
      createdAt: c.createdAt as string,
      where: "comment",
    });
  }
  for (const r of nodes(raw.reviews)) {
    // A review's inline comments arrive through its threads; only its summary counts here.
    if (!(r.body as string)?.trim() || !r.submittedAt) continue;
    feedback.push({
      id: r.id as string,
      url: r.url as string,
      author: login(r.author),
      body: r.body as string,
      createdAt: r.submittedAt as string,
      where: `review (${(r.state as string).toLowerCase().replace("_", " ")})`,
    });
  }
  for (const t of nodes(raw.reviewThreads)) {
    if (t.isResolved) continue;
    for (const c of nodes(t.comments)) {
      feedback.push({
        id: c.id as string,
        url: c.url as string,
        author: login(c.author),
        body: c.body as string,
        createdAt: c.createdAt as string,
        where: t.path as string,
      });
    }
  }
  feedback.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  return {
    repo,
    number: raw.number as number,
    url: raw.url as string,
    title: raw.title as string,
    state: raw.state as PullState["state"],
    author: login(raw.author),
    headRef: raw.headRefName as string,
    headSha: raw.headRefOid as string,
    baseRef: raw.baseRefName as string,
    fromFork: raw.isCrossRepository === true,
    mergeable: raw.mergeable as PullState["mergeable"],
    checks: { state: (status?.state as string) ?? null, failing },
    feedback,
  };
}
