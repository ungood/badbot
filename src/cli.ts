#!/usr/bin/env node
import { Command } from "@commander-js/extra-typings";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findRepo, loadConfig, owners, type Config } from "./config.js";
import { Daemon } from "./daemon.js";
import { execFileAsync, runShell } from "./exec.js";
import { createApp } from "./github/app-create.js";
import { GitHub } from "./github/client.js";
import { cachedToken, gitCredential, installIdentity, runGh } from "./identity.js";
import { installInbox } from "./inbox/install.js";
import { CloudflareQueue } from "./inbox/queue.js";
import { Orca } from "./orca/cli.js";
import { configDir, logFile } from "./paths.js";
import { Router } from "./router.js";
import { installService, uninstallService } from "./service.js";
import { Store } from "./state.js";

const log = (message: string): void => console.log(`${new Date().toISOString()} ${message}`);
const cli = realpathSync(process.argv[1] ?? ".");

// Secrets come from commands (fnox by default), run in badbot's config directory.
async function secret(command: string, what: string): Promise<string> {
  await mkdir(configDir(), { recursive: true });
  const { code, output } = await runShell(command, { cwd: configDir(), env: process.env });
  const value = output.trim();
  if (code !== 0 || !value) throw new Error(`couldn't read the ${what} with \`${command}\``);
  return value;
}

async function app(config: Config): Promise<GitHub> {
  if (!config.github.appId) {
    throw new Error("no [github] app_id in config.toml yet; run `badbot app create` first");
  }
  return new GitHub(
    config.github.appId,
    await secret(config.github.privateKeyCommand, "GitHub App private key"),
  );
}

async function token(config: Config, owner: string): Promise<string> {
  return cachedToken(owner, async () => (await app(config)).installationToken(owner));
}

async function setup(): Promise<{ config: Config; store: Store; github: GitHub; router: Router }> {
  const config = await loadConfig();
  const store = await Store.open();
  const github = await app(config);
  const bot = await github.bot();
  const router = new Router(config, store, github, new Orca(config.orcaBin), log, bot.login);
  return { config, store, github, router };
}

const program = new Command()
  .name("badbot")
  .description("Wake the Orca agent that owns a PR when something happens to it");

program
  .command("daemon")
  .description("Drain the inbox, sweep GitHub, and wake agents (launchd runs this)")
  .option("--once", "run one pass, including a sweep, then exit")
  .action(async (opts) => {
    const { config, store, github, router } = await setup();
    const cf = config.cloudflare;
    const queue = cf
      ? new CloudflareQueue(
          cf.accountId,
          cf.tokenCommand
            ? await secret(cf.tokenCommand, "Cloudflare API token")
            : (process.env.CLOUDFLARE_API_TOKEN ?? ""),
          cf.name,
        )
      : undefined;
    if (!queue) log("no [cloudflare] in config.toml: sweeping only");
    const daemon = new Daemon(config, store, router, github, queue, log);
    if (opts.once) await daemon.tick(true);
    else await daemon.run();
  });

program
  .command("reconcile")
  .description("Re-read one PR and act on it now, as if an event had arrived")
  .argument("<pr>", "the PR, as owner/name#number")
  .action(async (pr) => {
    const [, name, number] = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(pr) ?? [];
    if (!name || !number) throw new Error("expected owner/name#number");
    const { config, router } = await setup();
    const repo = findRepo(config, name);
    if (!repo) throw new Error(`${name} isn't in any watched workplace's badbot.toml`);
    await router.reconcilePull(repo, Number(number), "event");
  });

const appCommand = program.command("app").description("badbot's GitHub App");
appCommand
  .command("create")
  .description("Register the GitHub App, store its key and webhook secret, and install it")
  .option("--name <name>", "the App's name; its bot is <name>[bot]")
  .option("--org <org>", "register the App under an organization instead of your account")
  .option("--store <command>", "command that stores a secret read from stdin", "fnox set")
  .action(async (opts) => {
    const config = await loadConfig();
    const store = await Store.open();
    const name = opts.name ?? owners(config)[0];
    if (!name) throw new Error("pass --name");
    const created = await createApp({
      name,
      ...(opts.org && { org: opts.org }),
      ...(store.state.inbox.url && { hookUrl: `${store.state.inbox.url}/github` }),
      open: async (url) => {
        await execFileAsync("open", [url]);
      },
      log,
    });
    log(`registered ${created.slug} (App ID ${created.id})`);

    for (const [key, value] of [
      ["BADBOT_APP_PRIVATE_KEY", created.pem],
      ["BADBOT_WEBHOOK_SECRET", created.webhookSecret],
    ] as const) {
      const { code, output } = await runShell(`${opts.store} ${key}`, {
        cwd: configDir(),
        env: process.env,
        input: value,
      });
      if (code === 0) {
        log(`stored ${key} with \`${opts.store}\``);
      } else {
        // Never lose the key: GitHub shows it only once.
        const file = join(configDir(), key.toLowerCase());
        await writeFile(file, value, { mode: 0o600 });
        log(
          `\`${opts.store} ${key}\` failed, so it's in ${file} (mode 600); move it somewhere safer:\n${output}`,
        );
      }
    }

    const configFile = join(configDir(), "config.toml");
    const text = await readFile(configFile, "utf8");
    if (/^\[github\]/m.test(text)) {
      log(`set app_id = ${created.id} under [github] in ${configFile}`);
    } else {
      await appendFile(configFile, `\n[github]\napp_id = ${created.id}\n`);
      log(`added app_id = ${created.id} to ${configFile}`);
    }
    const install = `${created.htmlUrl}/installations/new`;
    log(`now install it on ${owners(config).join(", ")}: ${install}`);
    await execFileAsync("open", [install]).catch(() => undefined);
  });

const inbox = program.command("inbox").description("The always-on Cloudflare inbox");
for (const name of ["install", "update"]) {
  inbox
    .command(name)
    .description(
      name === "install"
        ? "Create the queue and Worker, and point the GitHub App's webhook at it"
        : "Redeploy the Worker and refresh the webhook (same steps as install)",
    )
    .action(async () => {
      const config = await loadConfig();
      const store = await Store.open();
      const cf = config.cloudflare;
      const url = await installInbox(
        config,
        store,
        await app(config),
        {
          cloudflareToken: cf?.tokenCommand
            ? await secret(cf.tokenCommand, "Cloudflare API token")
            : (process.env.CLOUDFLARE_API_TOKEN ?? ""),
          webhookSecret: await secret(config.github.webhookSecretCommand, "webhook secret"),
        },
        log,
      );
      log(`inbox is live at ${url}`);
    });
}

const identity = program.command("identity").description("Let agents act as the App's bot");
identity
  .command("install")
  .description("Write the git config and gh wrapper, and print the Claude Code settings to add")
  .action(async () => {
    const config = await loadConfig();
    const { bot, settings } = await installIdentity(await app(config), owners(config), cli);
    log(`agents in ${owners(config).join(", ")} repos will act as ${bot.login} <${bot.email}>`);
    console.log(
      "\nMerge this into the settings.json of the Claude config the agents use:\n\n" +
        JSON.stringify(settings, null, 2),
    );
  });

program
  .command("token")
  .description("Print an installation token for an owner's repos (cached until near expiry)")
  .argument("<owner>")
  .action(async (owner) => console.log(await token(await loadConfig(), owner)));

program
  .command("git-credential")
  .description("git credential helper that answers with the bot's token")
  .argument("<operation>")
  .action(async (operation) => {
    const config = await loadConfig();
    let input = "";
    for await (const chunk of process.stdin) input += String(chunk);
    process.stdout.write(
      await gitCredential(operation, input, owners(config), (o) => token(config, o)),
    );
  });

const service = program.command("service").description("Run the daemon under launchd");
service
  .command("install")
  .description("Install and start the launchd agent")
  .action(async () => log(`installed ${await installService(cli)}; logs: badbot logs -f`));
service
  .command("uninstall")
  .description("Stop and remove the launchd agent")
  .action(async () => {
    await uninstallService();
    log("uninstalled");
  });

program
  .command("logs")
  .description("Show the daemon's log")
  .option("-f, --follow", "keep printing new lines")
  .action((opts) => {
    const args = ["-n", "200", ...(opts.follow ? ["-F"] : []), logFile()];
    spawn("tail", args, { stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
  });

async function main(): Promise<void> {
  // gh's own flags must pass through untouched, so the wrapper skips commander.
  if (process.argv[2] === "gh") {
    const config = await loadConfig();
    process.exitCode = await runGh(process.argv.slice(3), owners(config), (o) => token(config, o));
    return;
  }
  await program.parseAsync();
}

main().catch((error: unknown) => {
  console.error(`badbot: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
