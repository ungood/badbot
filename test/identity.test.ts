import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  cachedToken,
  ghTargetOwner,
  gitconfigs,
  gitCredential,
  remoteOwner,
} from "../src/identity.js";

const exec = promisify(execFile);
const bot = {
  slug: "ungood",
  login: "ungood[bot]",
  id: 42,
  email: "42+ungood[bot]@users.noreply.github.com",
};

describe("cachedToken", () => {
  it("reuses a token until five minutes before it expires", async () => {
    const file = join(await mkdtemp(join(tmpdir(), "badbot-test-")), "tokens.json");
    let minted = 0;
    const mint = async () => ({
      token: `t${++minted}`,
      expiresAt: new Date(3_600_000).toISOString(),
    });
    expect(await cachedToken("Ungood", mint, 0, file)).toBe("t1");
    expect(await cachedToken("ungood", mint, 3_000_000, file)).toBe("t1");
    expect(await cachedToken("ungood", mint, 3_400_000, file)).toBe("t2");
  });
});

describe("remote owners", () => {
  it("reads https and ssh remotes", () => {
    expect(remoteOwner("https://github.com/ungood/place.git")).toBe("ungood");
    expect(remoteOwner("git@github.com:cyc-seattle/gam.git")).toBe("cyc-seattle");
    expect(remoteOwner("https://gitlab.com/ungood/x")).toBeUndefined();
  });

  it("finds the repo gh will act on", () => {
    expect(
      ghTargetOwner(["pr", "view", "-R", "cyc-seattle/gam"], "https://github.com/ungood/x"),
    ).toBe("cyc-seattle");
    expect(ghTargetOwner(["pr", "view", "--repo=ungood/place"], undefined)).toBe("ungood");
    expect(ghTargetOwner(["pr", "list"], "git@github.com:ungood/factory.git")).toBe("ungood");
    expect(ghTargetOwner(["api", "user"], undefined)).toBeUndefined();
  });
});

describe("gitCredential", () => {
  const token = async (owner: string) => `token-for-${owner}`;
  it("answers for watched owners only", async () => {
    const ask = (path: string) =>
      gitCredential("get", `protocol=https\nhost=github.com\npath=${path}\n`, ["ungood"], token);
    expect(await ask("ungood/place.git")).toBe(
      "username=x-access-token\npassword=token-for-ungood\n",
    );
    expect(await ask("cyc-seattle/gam.git")).toBe("");
    expect(await gitCredential("store", "", ["ungood"], token)).toBe("");
  });
});

describe("gitconfigs", () => {
  it("switches to the bot only in repos whose remote belongs to a watched owner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "badbot-test-"));
    const user = join(dir, "user.gitconfig");
    await writeFile(
      user,
      "[user]\n\tname = Jason\n\temail = jason@example.com\n[commit]\n\tgpgsign = true\n" +
        '[credential]\n\thelper = "!f() { echo username=jason; echo password=mine; }; f"\n',
    );
    // Stands in for the badbot shim: answers like `badbot git-credential get`.
    await writeFile(
      join(dir, "badbot"),
      "#!/bin/sh\ncat >/dev/null\necho username=x-access-token\necho password=bot-token\n",
      { mode: 0o755 },
    );
    const env = { ...process.env, XDG_CONFIG_HOME: dir, GIT_CONFIG_NOSYSTEM: "1" };
    const files = gitconfigs(bot, ["ungood"], dir, [user]);
    await writeFile(join(dir, "bot.gitconfig"), files.bot);
    await writeFile(join(dir, "agent.gitconfig"), files.agent);

    const repo = async (remote: string) => {
      const path = await mkdtemp(join(dir, "repo-"));
      await exec("git", ["init", "-q", path]);
      await exec("git", ["-C", path, "remote", "add", "origin", remote]);
      return path;
    };
    const get = async (path: string, key: string, flag = "--get") =>
      (
        await exec("git", ["-C", path, "config", flag, key], {
          env: { ...env, GIT_CONFIG_GLOBAL: join(dir, "agent.gitconfig") },
        })
      ).stdout.trim();

    const mine = await repo("https://github.com/ungood/place.git");
    expect(await get(mine, "user.name")).toBe("ungood[bot]");
    expect(await get(mine, "user.email")).toBe(bot.email);
    expect(await get(mine, "commit.gpgsign")).toBe("false");
    const fill = async (path: string, remote: string) =>
      (
        await exec(
          "sh",
          ["-c", `printf 'url=${remote}\\n\\n' | git -C "${path}" credential fill`],
          {
            env: {
              ...env,
              GIT_CONFIG_GLOBAL: join(dir, "agent.gitconfig"),
              GIT_TERMINAL_PROMPT: "0",
            },
          },
        )
      ).stdout;
    // Pushes use the bot's token, not your own credential helper.
    expect(await fill(mine, "https://github.com/ungood/place.git")).toContain("password=bot-token");

    const ssh = await repo("git@github.com:ungood/place.git");
    expect(await get(ssh, "user.name")).toBe("ungood[bot]");

    const work = await repo("https://github.com/cyc-seattle/gam.git");
    expect(await get(work, "user.name")).toBe("Jason");
    expect(await get(work, "commit.gpgsign")).toBe("true");
    expect(await fill(work, "https://github.com/cyc-seattle/gam.git")).toContain("password=mine");
  });
});
