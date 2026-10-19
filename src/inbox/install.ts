// Deploys the always-on inbox with wrangler: a queue with an HTTP pull
// consumer, and a Worker that verifies GitHub's signature and queues
// references. Then points the GitHub App's webhook at it. Safe to re-run,
// which is all `inbox update` does.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.js";
import { runShell } from "../exec.js";
import type { GitHub } from "../github/client.js";
import { packageRoot } from "../package-root.js";
import type { Store } from "../state.js";

export interface InboxSecrets {
  cloudflareToken: string;
  webhookSecret: string;
}

export async function installInbox(
  config: Config,
  store: Store,
  github: GitHub,
  secrets: InboxSecrets,
  log: (line: string) => void,
): Promise<string> {
  const cf = config.cloudflare;
  if (!cf) throw new Error("config.toml has no [cloudflare] table");
  const root = packageRoot();
  const wrangler = join(root, "node_modules", ".bin", "wrangler");
  const env = {
    ...process.env,
    CLOUDFLARE_API_TOKEN: secrets.cloudflareToken,
    CLOUDFLARE_ACCOUNT_ID: cf.accountId,
    WRANGLER_SEND_METRICS: "false",
  };
  const dir = await mkdtemp(join(tmpdir(), "badbot-inbox-"));
  try {
    const configFile = join(dir, "wrangler.json");
    await writeFile(
      configFile,
      JSON.stringify(
        {
          name: cf.name,
          main: join(root, "worker", "index.ts"),
          compatibility_date: "2026-10-01",
          workers_dev: true,
          queues: { producers: [{ binding: "INBOX", queue: cf.name }] },
        },
        null,
        2,
      ),
    );
    const run = async (
      args: string,
      opts: { input?: string; okIf?: RegExp } = {},
    ): Promise<string> => {
      const { code, output } = await runShell(`"${wrangler}" ${args} --config "${configFile}"`, {
        cwd: dir,
        env,
        ...(opts.input !== undefined && { input: opts.input }),
      });
      if (code !== 0 && !(opts.okIf && opts.okIf.test(output))) {
        throw new Error(`wrangler ${args.split(" ")[0]} failed:\n${output}`);
      }
      return output;
    };

    log(`queue ${cf.name}`);
    await run(`queues create ${cf.name}`, { okIf: /already (exists|taken)/i });
    // Retries happen when the daemon can't act yet, for example while Orca is closed.
    await run(`queues consumer http add ${cf.name} --message-retries 100`, { okIf: /already/i });

    log(`worker ${cf.name}`);
    const deployed = await run("deploy");
    const url = deployed.match(/https:\/\/[\w.-]+\.workers\.dev/)?.[0];
    if (!url) throw new Error(`couldn't find the Worker's URL in wrangler's output:\n${deployed}`);
    await run("secret put GITHUB_WEBHOOK_SECRET", { input: secrets.webhookSecret });

    store.state.inbox.url = url;
    await store.save();

    // One webhook for every repo the App is installed on.
    await github.setWebhook(`${url}/github`, secrets.webhookSecret);
    log(`pointed the GitHub App's webhook at ${url}/github`);
    return url;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
