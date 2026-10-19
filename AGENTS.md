# badbot

badbot is a TypeScript CLI that wakes the Orca agent that owns a pull request when something happens to it. It runs as the GitHub App `ungood`, whose bot is `ungood[bot]`. The design is in `docs/design.md`; read it before changing behavior.

## Repo paths

- `src/cli.ts`: the commands. Each command is a thin layer over a module.
- `src/router.ts`: re-reads a PR and turns its signals into Orca actions. Everything that wakes an agent goes through `Router.reconcilePull`.
- `src/signals.ts`: pure logic that decides what about a PR needs attention. Signal keys make every action happen once.
- `src/daemon.ts`: the loop that drains the inbox queue and the Run's inbox, and sweeps.
- `src/orca/cli.ts`: the only module that runs `orca`.
- `src/github/`: the App client, PR normalization, webhook mapping, signature checks and App registration. `events.ts`, `signature.ts` and `src/inbox/message.ts` are shared with the Worker, so they use no Node or Workers APIs.
- `src/identity.ts`: the git config, credential helper and `gh` wrapper that let agents act as the bot.
- `worker/index.ts`: the Cloudflare Worker, type-checked with `worker/tsconfig.json`.
- `test/`: Vitest tests. The router tests use fake Orca and GitHub clients. `identity.test.ts` runs real git.

## Conventions

- mise provides Node and pnpm and the tasks: `mise run build`, `mise run test`, `mise run lint`, `mise run fmt`. Run `mise run lint` and `mise run test` before committing.
- Tests never touch the network, Orca or Cloudflare.
- Work is tracked in GitHub Issues on `ungood/badbot`. Issue numbers and URLs go in commits and PRs only, never in source.
- Log lines are for the person watching badbot's Orca terminal: say what happened to which PR, in plain words.
