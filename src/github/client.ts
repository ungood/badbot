import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { normalizePull, PULL_FIELDS, type PullState } from "./pulls.js";

export interface Behind {
  by: number;
  baseSha: string;
}

export interface HookDelivery {
  id: number;
  guid: string;
  deliveredAt: string;
  ok: boolean;
}

export interface Bot {
  slug: string;
  login: string; // slug[bot]
  id: number;
  email: string;
}

export function splitRepo(repo: string): { owner: string; repo: string } {
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error(`expected owner/name, got ${repo}`);
  return { owner, repo: name };
}

// Everything badbot does on GitHub, as the GitHub App. App-level calls (its
// webhook, its identity) authenticate with a JWT; repo calls use an
// installation token for the repo's owner, which Octokit renews as needed.
export class GitHub {
  private readonly installations = new Map<string, Promise<Octokit>>();

  constructor(
    private readonly appId: number,
    private readonly privateKey: string,
    private readonly app = new Octokit({
      authStrategy: createAppAuth,
      auth: { appId, privateKey },
      userAgent: "badbot",
    }),
  ) {}

  private forOwner(owner: string): Promise<Octokit> {
    const key = owner.toLowerCase();
    let octokit = this.installations.get(key);
    if (!octokit) {
      octokit = (async () => {
        const { data } = await this.app.apps
          .getUserInstallation({ username: owner })
          .catch(() => this.app.apps.getOrgInstallation({ org: owner }));
        return new Octokit({
          authStrategy: createAppAuth,
          auth: { appId: this.appId, privateKey: this.privateKey, installationId: data.id },
          userAgent: "badbot",
        });
      })();
      octokit.catch(() => this.installations.delete(key));
      this.installations.set(key, octokit);
    }
    return octokit;
  }

  async installationToken(owner: string): Promise<{ token: string; expiresAt: string }> {
    const octokit = await this.forOwner(owner);
    const auth = (await octokit.auth({ type: "installation" })) as {
      token: string;
      expiresAt: string;
    };
    return { token: auth.token, expiresAt: auth.expiresAt };
  }

  async bot(): Promise<Bot> {
    const { data: app } = await this.app.apps.getAuthenticated();
    if (!app) throw new Error("GitHub didn't return the App");
    const slug = app.slug ?? app.name;
    const login = `${slug}[bot]`;
    const { data: user } = await this.app.users.getByUsername({ username: login });
    return { slug, login, id: user.id, email: `${user.id}+${login}@users.noreply.github.com` };
  }

  async pull(repo: string, number: number): Promise<PullState | undefined> {
    const { owner, repo: name } = splitRepo(repo);
    const octokit = await this.forOwner(owner);
    const data = await octokit.graphql<{
      repository: { pullRequest: Record<string, unknown> | null };
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) { pullRequest(number: $number) { ${PULL_FIELDS} } }
      }`,
      { owner, name, number },
    );
    const raw = data.repository.pullRequest;
    return raw ? normalizePull(repo, raw) : undefined;
  }

  async openPulls(repo: string): Promise<PullState[]> {
    const { owner, repo: name } = splitRepo(repo);
    const octokit = await this.forOwner(owner);
    const pulls: PullState[] = [];
    let cursor: string | null = null;
    do {
      const data: {
        repository: {
          pullRequests: {
            nodes: Record<string, unknown>[];
            pageInfo: { hasNextPage: boolean; endCursor: string };
          };
        };
      } = await octokit.graphql(
        `query($owner: String!, $name: String!, $cursor: String) {
          repository(owner: $owner, name: $name) {
            pullRequests(states: OPEN, first: 20, after: $cursor, orderBy: { field: UPDATED_AT, direction: DESC }) {
              nodes { ${PULL_FIELDS} }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { owner, name, cursor },
      );
      const page = data.repository.pullRequests;
      pulls.push(...page.nodes.map((n) => normalizePull(repo, n)));
      cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    } while (cursor);
    return pulls;
  }

  // How far the PR's head is behind its base branch's tip.
  async behind(repo: string, base: string, headSha: string): Promise<Behind> {
    const octokit = await this.forOwner(splitRepo(repo).owner);
    const { data } = await octokit.repos.compareCommits({
      ...splitRepo(repo),
      base,
      head: headSha,
      per_page: 1,
    });
    return { by: data.behind_by, baseSha: data.base_commit.sha };
  }

  async setWebhook(url: string, secret: string): Promise<void> {
    await this.app.apps.updateWebhookConfigForApp({
      url,
      secret,
      content_type: "json",
      insecure_ssl: "0",
    });
  }

  async webhookUrl(): Promise<string | undefined> {
    const { data } = await this.app.apps.getWebhookConfigForApp();
    return data.url;
  }

  // GitHub keeps deliveries for 3 days and never retries a failed one by itself.
  async recentDeliveries(since: Date): Promise<HookDelivery[]> {
    const out: HookDelivery[] = [];
    for await (const { data } of this.app.paginate.iterator(this.app.apps.listWebhookDeliveries, {
      per_page: 100,
    })) {
      for (const d of data) {
        if (new Date(d.delivered_at) < since) return out;
        out.push({
          id: d.id,
          guid: d.guid,
          deliveredAt: d.delivered_at,
          ok: d.status_code >= 200 && d.status_code < 300,
        });
      }
    }
    return out;
  }

  async redeliver(deliveryId: number): Promise<void> {
    await this.app.apps.redeliverWebhookDelivery({ delivery_id: deliveryId });
  }
}

// Deliveries that failed and have no successful attempt since, one per GUID.
export function failedDeliveries(deliveries: HookDelivery[]): HookDelivery[] {
  const byGuid = new Map<string, HookDelivery[]>();
  for (const d of deliveries) byGuid.set(d.guid, [...(byGuid.get(d.guid) ?? []), d]);
  const failed: HookDelivery[] = [];
  for (const attempts of byGuid.values()) {
    if (attempts.some((a) => a.ok)) continue;
    failed.push(attempts.reduce((a, b) => (a.deliveredAt <= b.deliveredAt ? a : b)));
  }
  return failed;
}
