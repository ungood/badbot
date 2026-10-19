# Design

badbot turns events on GitHub into Orca orchestration actions, so that the agent that owns a pull request wakes up when the PR needs it. The first milestone covers GitHub pull requests. Linear and Slack come later, through the same inbox and daemon.

The milestone is done when a review comment, a CI failure and a base branch moving on a factory PR each wake the agent that owns that PR, including after the laptop has slept through the event.

## Principles

Events are hints. The daemon never acts on a webhook's payload: it re-reads the PR from GitHub and decides from the PR's current state. A missed, duplicated or out-of-order event therefore can't cause a wrong action, only a late one, and the sweep bounds how late.

Every action happens once. Each signal carries keys, such as `ci:<head sha>` or `behind:<head sha>:<base sha>`, and the daemon records the keys it has acted on per PR. An event and a sweep that see the same state do nothing the second time.

badbot only orchestrates. It wakes agents and tells them what changed. The agents decide what to do, and they commit, push and reply themselves.

## Components

### The GitHub App

badbot is a GitHub App named `ungood`, registered on the `ungood` account, so its bot is `ungood[bot]`. A single App webhook covers every repo the App is installed on. The App asks for write access to contents, pull requests, issues and workflows, and read access to actions, checks and statuses. `badbot app create` registers it through GitHub's manifest flow and stores the private key and webhook secret with `fnox set`.

GitHub's GraphQL API reports a bot's login without the `[bot]` suffix, which would make `ungood[bot]` look like the user `ungood`. badbot adds the suffix back for any actor whose type is `Bot`.

### The inbox

A Cloudflare Worker receives the App's webhook. It verifies `X-Hub-Signature-256`, maps the delivery to the PRs or branch it touches, and sends a reference to a Cloudflare Queue: `{source, deliveryId, event, entity, receivedAt}`. It answers 202 at once. The queue has an HTTP pull consumer, so the laptop pulls from it whenever it's awake, and messages wait up to the queue's retention while it isn't.

Deliveries map to entities like this. Review, comment and PR events name a PR. `check_suite` and `workflow_run` name the PRs they ran for, once they complete. A push names the branch that moved, because PRs based on it may now be behind or conflicted. Issue events are queued but not routed yet.

`badbot inbox install` deploys the Worker and queue with wrangler, sets the Worker's secret, and points the App's webhook at the Worker. It's idempotent, and `inbox update` runs the same steps.

### The daemon

The daemon runs under launchd. Every 30 seconds it drains the queue and the Run's inbox (below). On wake, which it detects as a gap of more than three poll intervals, and every five minutes, it also sweeps: it lists every open PR in every watched repo, reconciles each one, and asks GitHub to redeliver App webhook deliveries from the last three days that never succeeded. The sweep is what catches a PR becoming conflicted or falling behind, since GitHub sends no event for either.

A queue message is acknowledged only after the daemon has acted on it. If acting fails, for example because Orca isn't running, the message is retried a minute later.

The first time a sweep meets a PR, it records the PR's current signals without acting on them, so starting badbot doesn't wake an agent for every stale PR. An event about a PR is always acted on.

### Signals

For an open PR whose author is in the workplace's `allow` list or is the bot, and whose head isn't in a fork, the daemon derives these signals:

- `review`: comments, review summaries and unresolved review-thread comments from people in `allow`, newer than badbot's start. The bot's own comments never count, because the bot isn't in `allow`.
- `ci_failed`: a failing check run or status on the head commit, once per head.
- `conflicted`: GitHub reports the PR as conflicting, once per head.
- `behind`: the base branch has commits the head doesn't, once per head and base tip. A conflict takes precedence.

Each workplace's `badbot.toml` can change what a signal does. A route has a prompt for the agent, a `run` command for a deterministic step such as a mise task, or both, and can be disabled. All the signals found in one pass go to the agent as one message.

### Ownership

Orca only lets a live terminal coordinate a Run, so the daemon keeps one Orca terminal of its own, titled `badbot`, which shows its log. It creates the Run once and rebinds it to a new terminal if the old one is closed.

Each PR has at most one owning Dispatch. When a PR has news:

1. If its owner is still working, badbot sends it a message (`orchestration send --to dispatch:<id>`) instead of starting another agent.
2. If its owner has settled and its terminal is still open, badbot starts a new Dispatch in that terminal, so the same agent session continues with its context.
3. Otherwise badbot adopts the agent already open in the PR's worktree, or starts one there, or creates a worktree for the PR and starts one in it.

When an owner sends `worker_done`, badbot retains its terminal for the PR's next event. When the PR merges or closes, badbot releases the terminal if it started the agent itself. A question from a worker gets a reply telling it to make a safe, reversible choice or to stop and explain itself in its terminal, since there's nobody on the other end.

## Agent identity

Agents act on GitHub as `ungood[bot]`. `badbot identity install` writes three things to `~/.config/badbot`:

- `agent.gitconfig`, which includes your own git config and then, only for repos whose remote is `github.com/ungood/*`, `bot.gitconfig`.
- `bot.gitconfig`, which sets the bot's name and noreply email, turns commit signing off, and replaces your credential helpers with `badbot git-credential`.
- A `gh` wrapper that sets `GH_TOKEN` to the bot's token when the target repo belongs to a watched owner.

The Claude config the agents use sets `GIT_CONFIG_GLOBAL` to `agent.gitconfig`, and a `SessionStart` hook puts the wrapper first on `PATH`. Scoping by repo owner, rather than by workplace, is deliberate: the Claude config is shared by all personal workplaces, and Orca puts worktrees outside the workplace's directory. Your own shell and other owners' repos keep your identity.

Installation tokens last an hour. badbot caches them in its state directory, readable only by you, and mints a new one five minutes before expiry, so git and gh calls don't read the private key each time.

### Signing

Bot commits are unsigned. GitHub verifies a signature against a user account's keys, and an App's bot has none. Commits created through GitHub's API with the App's token would be verified, but that would make agents commit through badbot instead of git. Your own commits are still signed. If a repo requires signed commits on `main`, squash merges satisfy it, because GitHub signs the merge commit.

## Work accounts

The App only has the permissions granted where it's installed, never yours. A private App owned by a personal account can't be installed on a work organization, and an organization would normally want to own its own App. At work, badbot would run with an App the organization registers, or without a bot identity.

## Open questions

- Whether Claude Code Channels is a better way than Orca's terminal input to wake an agent.
- What to contribute to Orca instead: webhook triggers ([stablyai/orca#5617](https://github.com/stablyai/orca/pull/5617)) and keeping merge-required work active ([stablyai/orca#21984](https://github.com/stablyai/orca/issues/21984)).
- What adopting an interactive session should do while you're typing in it. Orca queues the input, but the result hasn't been tested.
- Whether the sweep's GraphQL query needs to be cheaper for repos with many open PRs.
