// Two layers of config. The user's config.toml says which workplaces to
// watch, which GitHub App badbot is, and how to reach Cloudflare. Each workplace's badbot.toml says
// which repos it holds and how their events become actions, so repos never
// need to know about the router.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "smol-toml";
import { configDir } from "./paths.js";

export const SIGNAL_KINDS = ["review", "ci_failed", "conflicted", "behind"] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export interface Route {
  enabled: boolean;
  // Text for the agent that owns the PR. Placeholders: {repo} {number} {url}
  // {title} {branch} {base} {head} {details}.
  prompt?: string;
  // A deterministic step instead of (or before) waking the agent, such as a
  // mise task. Runs in the repo's checkout with BADBOT_* variables set.
  run?: string;
}

export interface RepoConfig {
  name: string; // owner/name
  path: string; // absolute path to the main checkout
  workplace: Workplace;
}

export interface Workplace {
  path: string;
  agent: string;
  // GitHub logins of the people whose reviews and comments count.
  allow: string[];
  routes: Record<SignalKind, Route>;
  repos: RepoConfig[];
}

export interface Config {
  workplaces: Workplace[];
  pollSeconds: number;
  sweepSeconds: number;
  orcaBin: string;
  github: {
    appId: number;
    // Commands that print the App's private key and webhook secret. They run
    // in badbot's config directory, so a fnox.toml there is picked up.
    privateKeyCommand: string;
    webhookSecretCommand: string;
  };
  cloudflare?: {
    accountId: string;
    tokenCommand?: string;
    name: string;
  };
}

export const DEFAULT_ROUTES: Record<SignalKind, Route> = {
  review: {
    enabled: true,
    prompt:
      "New review feedback on {url}:\n\n{details}\n\n" +
      "Address it: change the code, run the checks, push, and reply to each comment you handled.",
  },
  ci_failed: {
    enabled: true,
    prompt:
      "Checks failed on {url} at {head}:\n\n{details}\n\n" +
      "Find the cause, fix it, run the checks locally and push.",
  },
  conflicted: {
    enabled: true,
    prompt:
      "{url} now conflicts with {base}. Bring {branch} up to date with {base}, " +
      "resolve the conflicts, run the checks and push.",
  },
  behind: {
    enabled: true,
    prompt:
      "{base} has moved: {url} is {details}. Bring {branch} up to date with {base}, " +
      "run the checks and push.",
  },
};

type Table = Record<string, unknown>;

class ConfigError extends Error {}

function table(value: unknown, where: string): Table {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ConfigError(`${where} must be a table`);
  }
  return value as Table;
}

function str(value: unknown, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new ConfigError(`${where} must be a string`);
  return value;
}

function strings(value: unknown, where: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ConfigError(`${where} must be a list of strings`);
  }
  return value as string[];
}

function num(value: unknown, where: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || value <= 0) {
    throw new ConfigError(`${where} must be a positive number`);
  }
  return value;
}

export function parseWorkplace(path: string, text: string): Workplace {
  const where = join(path, "badbot.toml");
  const raw = table(parse(text), where);
  const routesRaw = table(raw.routes, `${where}: routes`);
  const routes = { ...DEFAULT_ROUTES };
  for (const [kind, value] of Object.entries(routesRaw)) {
    if (!(SIGNAL_KINDS as readonly string[]).includes(kind)) {
      throw new ConfigError(
        `${where}: unknown route "${kind}" (expected ${SIGNAL_KINDS.join(", ")})`,
      );
    }
    const r = table(value, `${where}: routes.${kind}`);
    const base = DEFAULT_ROUTES[kind as SignalKind];
    const run = str(r.run, `${where}: routes.${kind}.run`);
    // A route with only `run` doesn't also wake the agent.
    const prompt =
      str(r.prompt, `${where}: routes.${kind}.prompt`) ?? (run ? undefined : base.prompt);
    routes[kind as SignalKind] = {
      enabled: r.enabled === undefined ? true : r.enabled === true,
      ...(prompt !== undefined && { prompt }),
      ...(run !== undefined && { run }),
    };
  }
  const workplace: Workplace = {
    path,
    agent: str(raw.agent, `${where}: agent`) ?? "claude",
    allow: strings(raw.allow, `${where}: allow`) ?? [],
    routes,
    repos: [],
  };
  if (workplace.allow.length === 0) {
    throw new ConfigError(`${where}: allow must list the GitHub logins whose activity counts`);
  }
  for (const [name, value] of Object.entries(table(raw.repos, `${where}: repos`))) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(name)) {
      throw new ConfigError(`${where}: repos."${name}" must be owner/name`);
    }
    const repoPath =
      str(table(value, `${where}: repos."${name}"`).path, `${where}: repos."${name}".path`) ?? ".";
    workplace.repos.push({
      name,
      path: isAbsolute(repoPath) ? repoPath : resolve(path, repoPath),
      workplace,
    });
  }
  return workplace;
}

export function parseConfig(text: string, workplaces: Workplace[]): Config {
  const where = join(configDir(), "config.toml");
  const raw = table(parse(text), where);
  const cf =
    raw.cloudflare === undefined ? undefined : table(raw.cloudflare, `${where}: cloudflare`);
  const gh = table(raw.github, `${where}: github`);
  const orca = table(raw.orca, `${where}: orca`);
  let cloudflare: Config["cloudflare"];
  if (cf) {
    const accountId = str(cf.account_id, `${where}: cloudflare.account_id`);
    if (!accountId) throw new ConfigError(`${where}: cloudflare.account_id is required`);
    const tokenCommand = str(cf.token_command, `${where}: cloudflare.token_command`);
    cloudflare = {
      accountId,
      name: str(cf.name, `${where}: cloudflare.name`) ?? "badbot-github",
      ...(tokenCommand !== undefined && { tokenCommand }),
    };
  }
  return {
    workplaces,
    pollSeconds: num(raw.poll_seconds, `${where}: poll_seconds`) ?? 30,
    sweepSeconds: num(raw.sweep_seconds, `${where}: sweep_seconds`) ?? 300,
    orcaBin: str(orca.bin, `${where}: orca.bin`) ?? "orca",
    github: {
      appId: num(gh.app_id, `${where}: github.app_id`) ?? 0,
      privateKeyCommand:
        str(gh.private_key_command, `${where}: github.private_key_command`) ??
        "fnox get BADBOT_APP_PRIVATE_KEY",
      webhookSecretCommand:
        str(gh.webhook_secret_command, `${where}: github.webhook_secret_command`) ??
        "fnox get BADBOT_WEBHOOK_SECRET",
    },
    ...(cloudflare && { cloudflare }),
  };
}

export async function loadConfig(): Promise<Config> {
  const file = join(configDir(), "config.toml");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    throw new ConfigError(`no config at ${file}; see the README for an example`);
  }
  const raw = table(parse(text), file);
  const paths = strings(raw.workplaces, `${file}: workplaces`) ?? [];
  if (paths.length === 0)
    throw new ConfigError(`${file}: workplaces must list at least one workplace`);
  const workplaces: Workplace[] = [];
  for (const path of paths) {
    const wpFile = join(path, "badbot.toml");
    let wpText: string;
    try {
      wpText = await readFile(wpFile, "utf8");
    } catch {
      throw new ConfigError(`workplace ${path} has no badbot.toml`);
    }
    workplaces.push(parseWorkplace(resolve(path), wpText));
  }
  return parseConfig(text, workplaces);
}

export function findRepo(config: Config, name: string): RepoConfig | undefined {
  for (const workplace of config.workplaces) {
    const repo = workplace.repos.find((r) => r.name.toLowerCase() === name.toLowerCase());
    if (repo) return repo;
  }
  return undefined;
}

export function allRepos(config: Config): RepoConfig[] {
  const seen = new Set<string>();
  return config.workplaces.flatMap((w) =>
    w.repos.filter((r) => {
      const key = r.name.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  );
}

// The accounts whose repos badbot watches, and so where the App must be installed.
export function owners(config: Config): string[] {
  return [...new Set(allRepos(config).map((r) => (r.name.split("/")[0] ?? "").toLowerCase()))];
}
