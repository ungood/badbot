// Registers badbot's GitHub App with GitHub's manifest flow: a local page
// posts the manifest to GitHub, you confirm, and GitHub redirects back here
// with a code that's exchanged for the App's ID, private key and webhook secret.

import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface CreatedApp {
  id: number;
  slug: string;
  pem: string;
  webhookSecret: string;
  htmlUrl: string;
}

// What the agents need to work on PRs and their CI, and the events the router listens to.
export const APP_PERMISSIONS = {
  actions: "read",
  checks: "read",
  contents: "write",
  issues: "write",
  metadata: "read",
  pull_requests: "write",
  statuses: "read",
  workflows: "write",
} as const;

export const APP_EVENTS = [
  "check_suite",
  "issue_comment",
  "issues",
  "pull_request",
  "pull_request_review",
  "pull_request_review_comment",
  "pull_request_review_thread",
  "push",
  "workflow_run",
] as const;

export function manifest(name: string, redirectUrl: string, hookUrl: string | undefined): object {
  return {
    name,
    url: "https://github.com/ungood/badbot",
    description: "Wakes the Orca agent that owns a pull request when something happens to it.",
    public: false,
    redirect_url: redirectUrl,
    hook_attributes: {
      // `badbot inbox install` sets the real URL and secret once the Worker exists.
      url: hookUrl ?? "https://example.com/badbot-inbox-not-installed",
      active: hookUrl !== undefined,
    },
    default_permissions: APP_PERMISSIONS,
    default_events: APP_EVENTS,
  };
}

const html = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export async function createApp(options: {
  name: string;
  org?: string;
  hookUrl?: string;
  open: (url: string) => Promise<void>;
  log: (line: string) => void;
}): Promise<CreatedApp> {
  const state = randomBytes(16).toString("hex");
  const target = options.org
    ? `https://github.com/organizations/${encodeURIComponent(options.org)}/settings/apps/new`
    : "https://github.com/settings/apps/new";

  return new Promise<CreatedApp>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const port = (server.address() as AddressInfo).port;
      if (url.pathname === "/") {
        const body = JSON.stringify(
          manifest(options.name, `http://127.0.0.1:${port}/done`, options.hookUrl),
        );
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><form id="f" method="post" action="${target}?state=${state}">
<input type="hidden" name="manifest" value="${html(body)}">
<p>Sending badbot's App manifest to GitHub…</p><button>Continue</button></form>
<script>document.getElementById("f").submit()</script>`);
        return;
      }
      if (url.pathname === "/done") {
        const code = url.searchParams.get("code");
        if (url.searchParams.get("state") !== state || !code) {
          res.writeHead(400).end("This doesn't match the request badbot started.");
          return;
        }
        fetch(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
          method: "POST",
          headers: { accept: "application/vnd.github+json", "user-agent": "badbot" },
        })
          .then(async (r) => {
            if (!r.ok)
              throw new Error(`GitHub refused the manifest code: ${r.status} ${await r.text()}`);
            const app = (await r.json()) as {
              id: number;
              slug: string;
              pem: string;
              webhook_secret: string;
              html_url: string;
            };
            res.writeHead(200, { "content-type": "text/html" });
            res.end("<p>badbot's GitHub App is registered. You can close this tab.</p>");
            server.close();
            resolve({
              id: app.id,
              slug: app.slug,
              pem: app.pem,
              webhookSecret: app.webhook_secret,
              htmlUrl: app.html_url,
            });
          })
          .catch((error: unknown) => {
            res.writeHead(500).end(String(error));
            server.close();
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        return;
      }
      res.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1", () => {
      const start = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
      options.log(`opening ${start} to register the App on GitHub`);
      options.open(start).catch(() => options.log(`open ${start} in a browser to continue`));
    });
    setTimeout(
      () => {
        server.close();
        reject(new Error("gave up waiting for GitHub after 10 minutes"));
      },
      10 * 60 * 1000,
    ).unref();
  });
}
