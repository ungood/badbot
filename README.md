# badbot

badbot wakes the [Orca](https://github.com/stablyai/orca) agent that owns a pull request when something happens to it: a review comment, a CI failure, a conflict, or its base branch moving. It keeps working while the laptop sleeps, because GitHub's webhooks land in an always-on Cloudflare inbox, and a sweep of GitHub's API catches anything that arrives no event for.

badbot is a GitHub App. Its bot, `ungood[bot]`, is also the identity the agents use, so their commits, pushes, PRs and comments are the bot's rather than yours. The name is a pun on `ungood`.

## How it works

- **Inbox:** a Cloudflare Worker verifies each GitHub delivery and queues a reference to the PR or branch it touches.
- **Daemon:** runs under launchd. It drains the queue, re-reads each PR from GitHub, and acts through Orca orchestration. It also sweeps every open PR on wake and every five minutes, and asks GitHub to redeliver webhooks that failed.
- **Owner:** each PR has one agent. A busy owner gets a message. A finished one is resumed in the same terminal, so it keeps its context. A PR nobody owns is handed to the agent already in its worktree, or to a new agent in a new worktree.

See [the design](docs/design.md) for the details.

## Setup

badbot needs Orca, mise, gh, fnox (or another way to fetch secrets), and a Cloudflare account.

1. Build it: `mise run build`, then put `dist/src/cli.js` on your PATH as `badbot`, or call it through `node`.
2. Write `~/.config/badbot/config.toml`:

   ```toml
   workplaces = ["/Volumes/Workplaces/factory"]

   [cloudflare]
   account_id = "..."
   token_command = "fnox get CLOUDFLARE_API_TOKEN"
   ```

3. Write `badbot.toml` in each workplace:

   ```toml
   # The people whose reviews and comments count.
   allow = ["ungood"]

   [repos."ungood/factory"]
   path = "."

   [repos."ungood/place"]
   path = "place"

   # Optional: change what happens for a signal (review, ci_failed, conflicted, behind).
   [routes.behind]
   run = "mise run sync-branch"
   ```

4. Register the App: `badbot app create`. GitHub asks you to confirm, then badbot stores the private key and webhook secret with `fnox set` (run in `~/.config/badbot`, so put a `fnox.toml` there), adds `app_id` to `config.toml`, and opens the page to install the App on your account.
5. Deploy the inbox: `badbot inbox install`. Run `badbot inbox update` after upgrading badbot.
6. Start the daemon: `badbot service install`. Watch it with `badbot logs -f`, or in the `badbot` terminal it opens in Orca.
7. Let agents act as the bot: `badbot identity install`, then merge the settings it prints into the `settings.json` of the Claude config your agents use.

## Commands

- `badbot daemon [--once]`: the loop launchd runs. `--once` runs one pass with a sweep.
- `badbot reconcile owner/name#123`: re-read one PR and act on it now.
- `badbot app create`: register the GitHub App.
- `badbot inbox install` and `badbot inbox update`: deploy the Worker and point the App's webhook at it.
- `badbot identity install`: write the bot's git config and `gh` wrapper.
- `badbot token <owner>`, `badbot git-credential`, `badbot gh`: the bot's credentials, for scripts, git and gh.
- `badbot service install` and `badbot service uninstall`: manage the launchd agent.
- `badbot logs [-f]`: the daemon's log.

## License

MIT
