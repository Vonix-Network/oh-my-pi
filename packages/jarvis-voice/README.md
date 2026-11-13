# omp-jarvis

A voice-first **system agent** console for [omp](https://omp.sh).

`omp-jarvis` runs one `omp --mode rpc` session under a supervisory server and
puts a Jarvis-style HUD on top of it: hold a key and speak, watch the agent work,
hear the answer. It is built to run as a real service — locked to a single
instance, guarded against orphaned agents, token-gated, rate-limited, logged, and
health-checkable.

This is a fork-side package: it lives in the omp repo as
`packages/jarvis-voice` and depends on nothing outside Node's standard library.

## Why it exists

omp's own `/live` voice surface needs a realtime provider credential
(`live_start` fails with `No Codex OAuth credential is available for a live
call`), and dictation needs `stt.enabled`. Those are server-side paths this
console does not take. Instead:

- **Listening and speaking happen in the browser** (Web Speech API), which needs
  no credential and no model download.
- **The agent runs in the omp process**, driven over the documented RPC/JSONL
  protocol, so every tool, rule, skill, MCP server and memory backend works
  exactly as it does in the terminal.
- When the browser has no recognizer, the HUD says so instead of pretending to
  listen.

## The system-agent doctrine

The console appends [`agent/SYSTEM-AGENT.md`](agent/SYSTEM-AGENT.md) through omp's
documented `--append-system-prompt` route. That keeps the stock tool policy,
project context, rules and skills intact while adding:

- a risk table (R0–R4) that routes work before it is attempted;
- evidence rules that fail closed on missing or candidate-mismatched proof;
- an explicit authority boundary for irreversible effects;
- a reporting contract (`STATUS`, `EVIDENCE`, `BLOCKERS`, `OWNER_ACTIONS`);
- voice-surface writing rules, and a one-handed-operator constraint.

Verified: asked to quote its own instructions, the running agent reproduced the
risk table and reporting contract verbatim.

Not the doctrine you want? Point `--doctrine <path>` at your own file, or pass
`--no-doctrine` to run the stock prompt alone.

## Run it

```bash
# Dev: no install needed, no build step, Node >= 20
node packages/jarvis-voice/src/cli.mjs --cwd ~/DEV/my-project

# or, from the package directory
npm start -- --cwd ~/DEV/my-project
```

Open <http://127.0.0.1:7801/>.

Hold **Space** and speak (or type in the composer). **Esc** stops the current
turn. **Enter** sends. **Shift+Enter** adds a newline.

## Configuration

Precedence: CLI flags → environment → config file → defaults.

```bash
node src/cli.mjs --print-config          # show the resolved result
```

Config file, first found wins:

```
/etc/omp-jarvis/config.json
~/.config/omp-jarvis/config.json
```

```jsonc
{
  "cwd": "/home/you/DEV/project",
  "port": 7801,
  "host": "127.0.0.1",
  "model": "deploy/deepseek-ai/deepseek-v4.1-flash-1017:max",
  "persist": false,
  "sessionDir": "/home/you/.local/state/omp-jarvis/sessions",
  "logDir": "/home/you/.local/state/omp-jarvis/logs",
  "logLevel": "info",
  "doctrine": true,
  "rateLimitPerMinute": 120
}
```

Unknown keys are **rejected**, not ignored — a misspelled option fails loudly
instead of silently running with the wrong blast radius.

Environment: `JARVIS_HOST`, `JARVIS_PORT`, `JARVIS_CWD`, `JARVIS_PROFILE`,
`JARVIS_MODEL`, `JARVIS_SESSION_DIR`, `JARVIS_TOKEN`, `JARVIS_LOG_DIR`,
`JARVIS_LOG_LEVEL`, `JARVIS_ALLOW_REMOTE`.

## Security model

This console drives an agent that reads and edits files, so the defaults are
deliberately narrow.

| Control | Behaviour |
|---|---|
| Bind address | Loopback only. A non-loopback bind requires **both** a token (≥16 chars) and `allowRemote: true`, or startup fails. |
| Auth | Token compared in constant time over SHA-256 digests, so length does not leak. Accepted via `x-jarvis-token`, `Authorization: Bearer`, or `?token=` (the query form exists because a WebSocket upgrade cannot set headers from page JS). |
| Origin | WebSocket upgrades and API calls from a foreign `Origin` are rejected. |
| Commands | A fixed allowlist with per-command field allowlists. A browser body cannot smuggle unrelated RPC fields, and `bash`, `login`, `logout` and session-forking commands are not reachable. |
| Rate limit | Per-client fixed window, default 120/min. `/api/health` and `/api/metrics` are exempt so a supervisor cannot 429 itself into reporting a healthy daemon as down. |
| Body size | Capped at 2 MiB, with a 413 before parsing. |
| Headers | CSP, `nosniff`, `no-referrer`, `SAMEORIGIN` on static assets. |
| Path traversal | Static paths resolve under `web/` and are rejected otherwise. |

`/api/health` is intentionally reachable without a token so systemd and external
monitors can probe it; it exposes only readiness and pid-level data.

## Operations

```bash
curl -s localhost:7801/api/health   | jq   # readiness + bridge state
curl -s localhost:7801/api/metrics  | jq   # counters, uptime, log path
```

`/api/health` returns **503** until the agent's RPC `ready` frame has arrived and
a `get_state` round-trip succeeded. A listening socket alone is not treated as
healthy — that is the difference between "the port is open" and "the agent can
answer".

Logs are JSONL, size-rotated (4 MB × 5), written to `--log-dir`. A closed stdout
pipe (e.g. piped into `head`) disables the console sink rather than killing the
daemon with EPIPE.

### systemd

A hardened user unit is provided at [`deploy/omp-jarvis.service`](deploy/omp-jarvis.service):

```bash
mkdir -p ~/.config/systemd/user
cp packages/jarvis-voice/deploy/omp-jarvis.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now omp-jarvis
journalctl --user -u omp-jarvis -f
```

Generate a token first and put it in the unit's `Environment=` line:

```bash
printf 'JARVIS_TOKEN=%s\n' "$(openssl rand -hex 24)"
```

## Lifecycle and failure behaviour

- **Single instance.** A lock file per port; a stale lock from a dead pid is
  reclaimed, a live one is reported (exit 3).
- **No orphaned agents.** Closing the child's stdin is omp's documented shutdown
  path, so when this process dies — including `SIGKILL`, where no handler runs —
  the agent exits with it. Signals and an orphaning watchdog are the backup.
  Verified: `kill -9` on the server left no `omp` process and released the port.
- **Crash restart with backoff.** The child is respawned with exponential backoff
  capped at 30 s, so a crash loop cannot spin the CPU.
- **Real readiness gate.** Startup exits **4** if the agent does not answer
  within the grace period, so a supervisor sees the failure instead of a
  half-up service.
- **Reconnect.** The HUD reconnects with backoff and replays recent frames, so a
  reload does not lose the conversation view.

## API surface

| Endpoint | Method | Auth | Purpose |
|---|---|---|---|
| `/` | GET | — | HUD |
| `/api/health` | GET | — | readiness (200/503) |
| `/api/metrics` | GET | — | counters, bridge state |
| `/api/state` | GET | token | session model, effort, context usage |
| `/api/history` | GET | token | recent projected frames |
| `/api/command` | POST | token | allowlisted command |
| `/api/shutdown` | POST | token | graceful stop |
| `/ws` | WS | token + origin | event stream + commands |

## Testing

```bash
cd packages/jarvis-voice
node --test ./test/            # 28 unit tests, no dependencies
npm run check                  # syntax check every shipped source file
```

Unit coverage: chunk reassembly (including duplicate, interleaved, orphan and
byte-length-mismatch rejection), line splitting across chunk boundaries, frame
projection, config validation and precedence, token comparison, origin checks,
rate-limit windows, and lock acquisition/reclaim.

End-to-end gates run during development against a live agent: doctrine
reachability, a real tool call round-trip, orphan prevention under `SIGKILL`,
auth rejection, rate limiting, and a headless render of the HUD at 1440/768/390
with programmatic overflow measurement.

## Layout

```
packages/jarvis-voice/
├── agent/SYSTEM-AGENT.md    # the operating doctrine appended to the prompt
├── deploy/omp-jarvis.service
├── src/
│   ├── cli.mjs             # entry: config, lock, guard, readiness
│   ├── config.mjs          # layered config + strict validation
│   ├── lifecycle.mjs       # single-instance lock, orphan prevention
│   ├── logger.mjs          # JSONL logs, rotation, EPIPE-safe stdout
│   ├── rpc-bridge.mjs      # omp RPC child: framing, v2 chunks, restart
│   ├── security.mjs        # token, origin, rate limit, correlation ids
│   ├── server.mjs          # HTTP + WS, projection, command allowlist
│   └── ws.mjs              # dependency-free RFC 6455 server
├── test/                   # node:test suites
└── web/                    # the HUD (no build step)
```

## Limitations

- Speech recognition needs Chrome or Edge; Firefox and Safari fall back to typing
  and the HUD says so.
- The HUD is single-user. There is no multi-tenant session isolation; run one
  instance per workspace and port.
- `omp` must be on `PATH`, or pass a config with an explicit command.
