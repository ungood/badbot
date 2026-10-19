import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const execFileAsync = promisify(execFile);

// Runs a configured shell command, such as `gh auth token` or `fnox get X`,
// and returns its trimmed stdout.
export async function commandOutput(command: string): Promise<string> {
  const { stdout } = await execFileAsync("/bin/sh", ["-c", command]);
  return stdout.trim();
}

export function runShell(
  command: string,
  options: { cwd: string; env: NodeJS.ProcessEnv; input?: string },
): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { cwd: options.cwd, env: options.env });
    let output = "";
    child.stdout.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
    child.stdin.end(options.input ?? "");
  });
}
