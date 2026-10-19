// Runs the daemon under launchd, as the logged-in user.

import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { execFileAsync } from "./exec.js";
import { logFile, stateDir } from "./paths.js";

export const LABEL = "io.github.ungood.badbot";

const plistPath = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = (): string => `gui/${userInfo().uid}`;

const xml = (s: string): string =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

export function plist(program: string[], env: Record<string, string>, log: string): string {
  const args = program.map((a) => `    <string>${xml(a)}</string>`).join("\n");
  const vars = Object.entries(env)
    .map(([k, v]) => `    <key>${xml(k)}</key>\n    <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>StandardOutPath</key>
  <string>${xml(log)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(log)}</string>
</dict>
</plist>
`;
}

export async function installService(cli: string): Promise<string> {
  // launchd starts with a bare environment. Keep this shell's PATH so the
  // daemon finds orca, gh and the secret commands the config names.
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: homedir(),
  };
  for (const name of ["XDG_CONFIG_HOME", "XDG_STATE_HOME"]) {
    const value = process.env[name];
    if (value) env[name] = value;
  }
  await mkdir(stateDir(), { recursive: true });
  await mkdir(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
  await writeFile(plistPath(), plist([process.execPath, cli, "daemon"], env, logFile()));
  await execFileAsync("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => undefined);
  await execFileAsync("launchctl", ["bootstrap", domain(), plistPath()]);
  return plistPath();
}

export async function uninstallService(): Promise<void> {
  await execFileAsync("launchctl", ["bootout", `${domain()}/${LABEL}`]).catch(() => undefined);
  await rm(plistPath(), { force: true });
}
