import { homedir } from "node:os";
import { join } from "node:path";

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "badbot");
}

export function stateDir(): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "badbot");
}

export const logFile = (): string => join(stateDir(), "daemon.log");
