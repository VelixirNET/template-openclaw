# OpenClaw

[![Deploy on velixir](https://velixir.net/img/deploy-on-velixir.svg)](https://velixir.net/new?template=openclaw)

> **This is a sandbox.** Its workspace, memory, chats, paired browsers and Telegram approvals are
> wiped whenever the app restarts or redeploys. Its settings come back from your environment
> variables, so it always starts configured, just empty.

[OpenClaw](https://openclaw.ai) (formerly Clawdbot) is an open-source AI assistant: a web Control
UI to chat with it, chat channels such as Telegram, and tools that let it act on its own machine,
from running shell commands to writing files and fetching web pages.

This template is the quickest way to try it on your own model and your own Telegram bot: set one
API key, deploy, and you are chatting with it in a few minutes, with nothing to install and no
server to look after. [Deploy it on velixir](https://velixir.net/new?template=openclaw).

**Good for:** trying OpenClaw before you commit to running it, experiments with agents and
tools, and disposable tasks (research, a script, a file conversion) where nothing needs to
survive.

**Not for:** a long-term assistant that remembers you, your files and your preferences. Anything
it learns or writes is gone after the next restart.

## What you get

- **OpenClaw's gateway and Control UI on your app's address**, over HTTPS, behind the gateway
  token. Every browser also has to be paired before it can do anything.
- **Configured from environment variables**, rebuilt on every start. There is no onboarding
  wizard to click through and nothing to redo after a restart except connecting your browser.
- **Your choice of model**: an Anthropic, OpenAI, Gemini, OpenRouter or xAI key, or any other
  provider OpenClaw bundles.
- **A Telegram bot, optional, locked by default.** Strangers who find it get a pairing code that
  only you can approve, or nothing at all with an allowlist.
- **Its own machine to work on.** The shell commands OpenClaw runs execute inside this app's own
  container: it can install packages and write files there, and nowhere else.

## Setting it up

1. **Deploy it.** Without a model key it serves a setup page that says what to set.
2. **Set a model key** on the app's Environment tab, marked as secret. Saving a variable
   redeploys the app.
3. **Set `OPENCLAW_GATEWAY_TOKEN`** to a long random value (`openssl rand -hex 32` makes one).
   Optional but recommended: without it, a new token is generated on every start (below).
4. **Open the app** and enter the token. Your browser connects as the owner and the Control UI
   opens. After every restart, open the app and enter it again.

| Variable | Required | What it does |
| --- | --- | --- |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY` or `XAI_API_KEY` | one of them | Your model provider's key. The first one found picks the default model. |
| `OPENCLAW_MODEL` | no | The model to use, as `provider/model`, for example `anthropic/claude-sonnet-5` to spend less per message. |
| `OPENCLAW_GATEWAY_TOKEN` | recommended | The token you sign in with, at least 24 characters. |
| `TELEGRAM_BOT_TOKEN` | no | A bot token from @BotFather, to chat with OpenClaw on Telegram. |
| `TELEGRAM_ALLOW_FROM` | no | Numeric Telegram user IDs allowed to message the bot, separated by commas. The first one is the owner. |
| `OPENCLAW_CONFIG_JSON` | no | Any other OpenClaw settings, as a JSON object merged into its config on every start. |
| `PUBLIC_URL` | no | Your own domain, for example `https://claw.example.com`, once you have added it to the app. |

Default models, by key: `anthropic/claude-opus-5-5` (Opus, the most capable, and priced like it), `openai/gpt-6-astra`,
`google/gemini-3.1-pro-preview`, `openrouter/auto` and `xai/grok-4.7`. For another provider
bundled with OpenClaw (MiniMax, NVIDIA, Together, Hugging Face and more), set its key together
with `OPENCLAW_MODEL`. Mistral, Groq and DeepSeek are separate OpenClaw plugins that are not in
this image; reach their models through OpenRouter.

## The gateway token

The token is the key to the whole assistant. Anyone who has it can chat with it, run commands in
its container, read what it has done and spend your API credit, so treat it like a password to
your model account.

If you set `OPENCLAW_GATEWAY_TOKEN`, that is the token. If you do not, the app generates a strong
random one when it starts and prints it once to the app's log, in a box that begins
**OpenClaw is ready**. That token changes on every restart. A sandbox has nowhere to keep a secret
between restarts (no database, and the disk is wiped), so a generated token cannot outlive one;
set the variable to keep the same token across restarts. Changing it later redeploys the app with
the new one.

## Connecting your browser

OpenClaw pairs every browser that connects: the token alone gets a browser as far as "Approve this
browser", and normally a command run on the server finishes the job. velixir apps have no shell to
run it in, so this template does that step for you.

Open the app's address, or `/velixir/pair` on it, and enter the token. The app then asks OpenClaw
for its own one-time owner link (the one `openclaw dashboard` creates on a server) and sends your
browser straight through it. The link works once, for ten minutes, and only for the browser that
opens it; your browser is then paired as the owner and never holds the token itself. It takes a
few seconds.

- **After a restart**, every paired browser is forgotten along with everything else. Open the
  app and enter the token again.
- **If the Control UI says "Approve this browser"**, you reached it without the connect page.
  Open `/velixir/pair` and enter the token there.
- **Another browser or device**: use the connect page on it, or approve it under **Devices** in a
  browser that is already connected.
- **Private windows** forget the pairing when they close, so they need connecting again.

## Telegram

1. In Telegram, message **@BotFather**, send `/newbot` and follow the prompts. It replies with
   the bot's token.
2. Set `TELEGRAM_BOT_TOKEN` to it on the Environment tab.
3. Message your bot. It replies with a pairing code and your numeric Telegram user ID.
4. In the Control UI, open **Settings > Channels > DM access requests** and approve the request.

Approvals are part of the sandbox's state, so they are gone after a restart. To skip that step for
good, set `TELEGRAM_ALLOW_FROM` to your user ID (and any others, separated by commas): the bot then
talks to those accounts only, from the first message after every start, and ignores everyone else.

Group chats are off until you add them to the config, for example
`{"channels":{"telegram":{"groups":{"-1001234567890":{"requireMention":true}}}}}` in
`OPENCLAW_CONFIG_JSON`. In groups the bot only listens to the people in `TELEGRAM_ALLOW_FROM`, so
set that too. The bot uses long polling, so nothing has to reach it from Telegram and it needs no
webhook.

Discord and Slack are not included. OpenClaw ships them as separate plugins; the Control UI can
install them, but an install lasts only until the next restart in this sandbox.

## Things to know

**Everything resets on a restart or redeploy.** Chats, memory, the workspace and any files the
agent made, paired browsers, Telegram approvals, installed plugins and settings changed in the
Control UI are all wiped. What comes back is what the environment variables say. To keep a setting,
put it in `OPENCLAW_CONFIG_JSON`: it is merged into OpenClaw's config on every start, except that
it cannot switch off the token, the loopback-only listener or the proxy settings.

**It needs an always-on plan with 2 GB of memory.** OpenClaw is large. In testing it idled at
about 0.8 to 0.9 GB, reached about 1.5 GB while the Control UI was in use, and the connect page
briefly adds about 0.4 GB while it makes a link. On 1 GB it was stopped for running out of memory.
The agent's own work (installing packages, running scripts) needs room on top. It must stay awake
to answer Telegram, which rules out plans that sleep. A start takes about 25 seconds.

**Your model provider bills the tokens.** Every message, tool call and follow-up turn is a paid
request to your provider. OpenClaw's heartbeat, a check-in turn every 30 minutes, is off in this
template so a forgotten sandbox does not keep spending; turn it on with
`{"agents":{"defaults":{"heartbeat":{"every":"30m"}}}}` in `OPENCLAW_CONFIG_JSON`. Set a spending
limit with your provider as well.

**The agent's shell is this container, and it runs as root.** That is the sandbox: OpenClaw can
install packages and run anything inside it, and nothing outside it. It also means the agent can
read everything the app can, including your API keys and bot token. Give it a key you can revoke,
with a spending limit, and remember that a web page or message it reads can try to talk it into
things.

**Web-only network access.** The app can reach DNS and ports 80 and 443, nothing else. Email over
SMTP or IMAP does not work, `git` needs HTTPS URLs rather than SSH, and a model server of your own
must be reachable over HTTPS on port 443.

**No browser.** This image has no Chromium, so OpenClaw's browser tool cannot start. The agent can
still fetch and read web pages.

**One replica.** All of OpenClaw's state lives in the one container, so it does not scale out.

**On your own domain**, add the domain to the app, then set `PUBLIC_URL` to it so OpenClaw
accepts browsers there too.

## What this repo is

A thin wrapper, not a fork. `package.json` depends on the `openclaw` npm package, pinned to an
exact release, and `start.js` turns what velixir provides into what OpenClaw expects:

| velixir provides | OpenClaw gets |
| --- | --- |
| `PORT` | a small proxy on `0.0.0.0:$PORT` in front of the gateway, which listens on loopback only |
| `VELIXIR_APP_SLUG` | `gateway.publicOrigin` and the allowed browser origins (override with `PUBLIC_URL`) |
| a model key | the model to start on (`agents.defaults.model`) |
| `TELEGRAM_*` | `channels.telegram` with pairing or an allowlist, and the owner |
| `OPENCLAW_CONFIG_JSON` | merged into `openclaw.json` |
| nothing | token auth always on, forwarded addresses trusted from the proxy only, heartbeat off, update checks off |

The proxy passes the visitor's address to the gateway, so OpenClaw's own checks see a remote
browser and never mistake it for a local process. It also serves `/healthz`, the setup page, and
`/velixir/pair`.

`package-lock.json` pins every dependency, OpenClaw's own included, with integrity hashes, so each
build installs exactly the same code. `allowScripts` in `package.json` lets OpenClaw's install
script run and declines the three others in its tree, which it works without. `nixpacks.toml`
pins a newer Node than the builder's own, because OpenClaw needs Node 24.16 or newer with a recent
SQLite, and starts `node start.js` directly so the stop signal on a redeploy reaches OpenClaw.

To upgrade OpenClaw, change its version in `package.json`, run `npm install` (Node 24.16 or newer)
to refresh the lockfile, and deploy. Read OpenClaw's release notes first.

## Running it locally

```bash
npm install
ANTHROPIC_API_KEY=your-key npm start
```

Then open http://localhost:8080 and enter the token printed in the terminal. It needs Node 24.16
or newer on the 24 line, or 26.1 or newer, as built by nodejs.org: OpenClaw refuses a Node that a
distribution built against an older system SQLite. OpenClaw's state goes in `.openclaw/` inside
this folder and is cleared on every start; your own `~/.openclaw` is never touched.

## Upstream

OpenClaw is MIT-licensed open source, stewarded by the OpenClaw Foundation. This wrapper is MIT
too.

- Docs: https://docs.openclaw.ai
- Source: https://github.com/openclaw/openclaw
