# Model providers

Omnigent routes each harness through a named provider from the `providers:`
block in `~/.omnigent/config.yaml` on the host that runs the session.
`omnigent setup` writes this block for you, and `omnigent config list` shows it.

| `kind`         | Authenticates with                                          |
| -------------- | ----------------------------------------------------------- |
| `subscription` | The `claude` / `codex` CLI's own login                      |
| `key`          | A vendor API key (`api_key_ref: env:VAR` or `keychain:...`) |
| `gateway`      | An OpenAI/Anthropic-compatible proxy                        |
| `local`        | A self-hosted endpoint such as Ollama                       |
| `databricks`   | A profile from `~/.databrickscfg`                           |
| `cli-config`   | A `[model_providers.X]` table in `~/.codex/config.toml`     |
| `bedrock`      | AWS Bedrock (native `omnigent claude` only)                 |

`default: true` makes a provider the default for the families it serves:
`anthropic` (Claude harnesses) and `openai` (Codex harnesses). Each family has
at most one default. An agent spec can pin a provider with
`executor.auth: {type: provider, name: ...}`.

## Several subscription accounts

A `claude` or `codex` subscription normally uses the CLI's single login in
`~/.claude` or `~/.codex`. There are two ways to add more accounts.

### Claude accounts that share sessions

Give each extra Claude account a token. The accounts keep using the same
`~/.claude` (sessions, settings, skills and plugins) and differ only in which
subscription pays, so a conversation started on one account can continue on
another:

```yaml
providers:
  claude-max1:
    kind: subscription
    cli: claude
    default: true
  claude-max2:
    kind: subscription
    cli: claude
    token_ref: keychain:claude-max2
```

Create the token with `claude setup-token`, signed in as that account. Then
run `omnigent setup`, open Claude, add a subscription, choose **Add another
account (token, shares sessions)** and paste it; setup stores it in the
Omnigent secret store. `token_ref` also accepts `env:<VAR>`. Omnigent gives
the token to Claude as `CLAUDE_CODE_OAUTH_TOKEN`, which takes precedence over
the login stored in `~/.claude`, and removing the account deletes only its
token.

### Accounts with separate logins

Give an account its own `config_dir` to keep its login, sessions and settings
apart, for example a second account next to your main one. This works for Codex
too:

```yaml
providers:
  claude-alt:
    kind: subscription
    cli: claude
    config_dir: ~/.claude-alt
  chatgpt-alt:
    kind: subscription
    cli: codex
    config_dir: ~/.codex-alt
    default: true
  databricks:
    kind: databricks
    profile: alt
```

`config_dir` accepts `~` and `$VAR`. Omnigent passes it to Claude as
`CLAUDE_CONFIG_DIR`, and to Codex as the `CODEX_HOME` that each session reads
`auth.json` and `config.toml` from. Entries without `config_dir` keep using the
CLI's default login.

Sign each account in once, on the host:

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt claude auth login --claudeai
CODEX_HOME=~/.codex-alt codex login
```

Or run `omnigent setup` and choose **Add another account (own login
directory)**. Setup asks for a name and a login directory, then opens that
account's login.

## Choosing the account for a session

In the web app, the **Account** section of the harness menu lists the selected
host's providers for that harness. It appears only when there is more than
one. The default provider is preselected. Accounts that are not signed in are
listed but cannot be selected.

A project can set a default account under **Project settings › Account**. New
sessions in that project start on it, and you can still pick another. It is
stored as `provider` in the project's settings. If the selected host cannot
run the chosen harness on that account, or it is not signed in there, the
session uses the host's default account and the composer says so.

Over the API, pass the provider name when creating a session on a host:

```http
POST /v1/sessions
{"agent_id": "...", "host_id": "...", "workspace": "/repo", "provider_override": "claude-max2"}
```

`GET /v1/hosts/{host_id}/providers?harness=claude-native` returns the choices.
It returns names and labels only, never credentials.

How the choice applies:

- The host checks it when it launches the session's runner. If the provider is
  not configured on the host, cannot run the harness, or is a subscription that
  is not signed in, the launch fails. The error names the account and the
  command that signs it in. Omnigent never falls back to another account.
- A claude-native session also fails to start if the agent's `env:` or the
  host's claude-native startup command (an `env` wrapper, for example) sets
  `CLAUDE_CONFIG_DIR` or `HOME` so that Claude would sign in from a directory
  other than the chosen account's, or replaces a token account's token.
- Sub-agents inherit the choice when they run in the same family, for example
  a Claude sub-agent of a Claude session. A Codex sub-agent of a Claude session
  uses the Codex default.
- It overrides the family default only. An agent whose spec pins
  `executor.auth` keeps its own credential, and the API rejects a different
  choice for it.
- Only sessions on a connected host can choose. Managed sandboxes use their
  deployment's inference settings.

## Switching a running session

A Claude session (claude-native or claude-sdk) can move to another provider
from the same **Account** menu while it runs, for example from one Max account
to another when the first runs out, or to Databricks. Only the session's owner
can switch it.

Omnigent saves the choice and restarts the session's runner on the new
provider. If the session or one of its sub-agents is mid-turn, or a question
is waiting on you, the restart waits until they finish. A claude-native
session's terminal then comes back and resumes the conversation; a claude-sdk
session resumes with its next message. The first turn after a switch starts
without the old account's prompt cache.

Claude keeps the conversation in its config directory, so a session can only
move between providers that use the same one: token accounts and gateway
providers such as Databricks share the host's `~/.claude`, while an account
with its own `config_dir` keeps its own conversations. The menu lists those
accounts but does not offer them for a running session; start a new session on
one instead.

Over the API:

```http
POST /v1/sessions/{session_id}/provider
{"provider": "claude-max2"}
```

`{"provider": null}` goes back to the host default. The response says whether
the switch applied at once (`"applied": "now"`) or waits for the current turn
(`"applied": "after_turn"`).
