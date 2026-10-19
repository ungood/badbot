// Lets agents act on GitHub as the App's bot (ungood[bot]) instead of as you.
//
// Claude Code sessions get GIT_CONFIG_GLOBAL pointing at agent.gitconfig,
// which includes your own git config and then, only for repos whose remote
// belongs to a watched owner, bot.gitconfig: the bot's name and email, and
// badbot as the credential helper. A `gh` wrapper on PATH does the same for
// gh. Your own shell keeps your identity, and other owners' repos keep
// yours too.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { execFileAsync } from "./exec.js";
import type { Bot, GitHub } from "./github/client.js";
import { configDir, stateDir } from "./paths.js";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

interface CachedToken {
  token: string;
  expiresAt: string;
}

// Installation tokens last an hour. Cache them so each git or gh call doesn't
// mint a new one, which would also mean reading the private key every time.
export async function cachedToken(
  owner: string,
  mint: () => Promise<CachedToken>,
  now = Date.now(),
  file = join(stateDir(), "tokens.json"),
): Promise<string> {
  let cache: Record<string, CachedToken> = {};
  try {
    cache = JSON.parse(await readFile(file, "utf8")) as Record<string, CachedToken>;
  } catch {
    // No cache yet.
  }
  const key = owner.toLowerCase();
  const hit = cache[key];
  if (hit && Date.parse(hit.expiresAt) - now > REFRESH_MARGIN_MS) return hit.token;
  const fresh = await mint();
  cache[key] = fresh;
  await mkdir(stateDir(), { recursive: true });
  await writeFile(file, JSON.stringify(cache), { mode: 0o600 });
  await chmod(file, 0o600);
  return fresh.token;
}

// The owner of a GitHub remote URL, in https or ssh form.
export function remoteOwner(url: string): string | undefined {
  const match = /github\.com[:/]([^/]+)\//.exec(url);
  return match?.[1];
}

export function parseCredentialRequest(input: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of input.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

// The owner `gh` will talk to: from -R/--repo, else from the origin remote.
export function ghTargetOwner(args: string[], origin: string | undefined): string | undefined {
  for (const [i, arg] of args.entries()) {
    const value =
      arg === "-R" || arg === "--repo"
        ? args[i + 1]
        : arg.startsWith("--repo=")
          ? arg.slice("--repo=".length)
          : undefined;
    if (value) return remoteOwner(value) ?? value.split("/")[0];
  }
  return origin ? remoteOwner(origin) : undefined;
}

export function gitconfigs(
  bot: Bot,
  owners: string[],
  binDir: string,
  userConfigs: string[],
): { agent: string; bot: string } {
  const quote = (s: string): string => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  const agent = [
    "# Written by `badbot identity install`. Claude Code sessions use this as their",
    "# global git config: yours, plus the bot's identity for repos the App acts on.",
    ...userConfigs.map((path) => `[include]\n\tpath = ${quote(path)}`),
    ...owners.flatMap((owner) =>
      [`https://github.com/${owner}/**`, `git@github.com:${owner}/**`].map(
        (pattern) =>
          // A relative path resolves next to this file.
          `[includeIf ${quote(`hasconfig:remote.*.url:${pattern}`)}]\n\tpath = bot.gitconfig`,
      ),
    ),
    "",
  ].join("\n");
  const botConfig = [
    "# Written by `badbot identity install`.",
    "[user]",
    `\tname = ${quote(bot.login)}`,
    `\temail = ${quote(bot.email)}`,
    "# GitHub can't verify a bot's own signature, so the bot doesn't sign.",
    "[commit]\n\tgpgsign = false",
    "[tag]\n\tgpgsign = false",
    '[credential "https://github.com"]',
    "\t# An empty helper drops your own helpers, so pushes use the bot's token.",
    '\thelper = ""',
    `\thelper = ${quote(`!${join(binDir, "badbot")} git-credential`)}`,
    "\tuseHttpPath = true",
    "",
  ].join("\n");
  return { agent, bot: botConfig };
}

export async function installIdentity(
  github: GitHub,
  owners: string[],
  cli: string,
): Promise<{ bot: Bot; settings: object }> {
  const bot = await github.bot();
  const dir = configDir();
  const binDir = join(dir, "bin");
  await mkdir(binDir, { recursive: true });

  const shim = async (name: string, body: string): Promise<void> => {
    await writeFile(join(binDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  await shim("badbot", `exec "${process.execPath}" "${cli}" "$@"`);
  await shim("gh", `exec "${join(binDir, "badbot")}" gh "$@"`);

  const xdg = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "config");
  const userConfigs = [xdg, join(homedir(), ".gitconfig")].filter((p) => existsSync(p));
  const files = gitconfigs(bot, owners, binDir, userConfigs);
  await writeFile(join(dir, "agent.gitconfig"), files.agent);
  await writeFile(join(dir, "bot.gitconfig"), files.bot);

  const settings = {
    env: { GIT_CONFIG_GLOBAL: join(dir, "agent.gitconfig") },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command: `echo 'export PATH="${binDir}:$PATH"' >> "$CLAUDE_ENV_FILE"`,
            },
          ],
        },
      ],
    },
  };
  return { bot, settings };
}

export async function gitCredential(
  operation: string,
  input: string,
  owners: string[],
  token: (owner: string) => Promise<string>,
): Promise<string> {
  if (operation !== "get") return "";
  const request = parseCredentialRequest(input);
  if (request.protocol !== "https" || request.host !== "github.com") return "";
  const owner = request.path?.split("/")[0];
  if (!owner || !owners.includes(owner.toLowerCase())) return "";
  return `username=x-access-token\npassword=${await token(owner)}\n`;
}

// Runs the real gh, as the bot when the target repo belongs to a watched owner.
export async function runGh(
  args: string[],
  owners: string[],
  token: (owner: string) => Promise<string>,
): Promise<number> {
  const binDir = join(configDir(), "bin");
  const path = (process.env.PATH ?? "").split(delimiter).filter((p) => p && p !== binDir);
  const gh = path.map((p) => join(p, "gh")).find((p) => existsSync(p));
  if (!gh) throw new Error("can't find gh on PATH");
  const origin = await execFileAsync("git", ["remote", "get-url", "origin"])
    .then((r) => r.stdout.trim())
    .catch(() => undefined);
  const owner = ghTargetOwner(args, origin);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path.join(delimiter) };
  if (owner && owners.includes(owner.toLowerCase())) env.GH_TOKEN = await token(owner);
  return new Promise((resolve, reject) => {
    spawn(gh, args, { stdio: "inherit", env })
      .on("error", reject)
      .on("exit", (code) => resolve(code ?? 1));
  });
}
