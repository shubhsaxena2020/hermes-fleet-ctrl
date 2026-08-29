# Hermes Fleet Commander — examples

Minimal, copy-paste starting points for running the control-plane daemon.

## 1. Environment file (`fleet-env.example`)

Drop this next to the systemd unit (or `source` it before `node dist/cli.js`).
Every value has a sensible default on the VPS; override only what you need.

```bash
# --- connection ---
FLEET_SOCKET=/home/ubuntu/.hermes/tmux/hermes-main.sock
FLEET_PORT=8787
FLEET_HOST=127.0.0.1          # local only — do not bind 0.0.0.0 without a proxy
FLEET_JOURNAL=/home/ubuntu/.hermes/fleet-ctrl/journal.db

# --- loop tuning ---
FLEET_POLL_MS=5000
FLEET_STUCK_MS=600000         # 10 min idle => STUCK

# --- circuit breaker (the watchdog's safety budget) ---
FLEET_MAX_RESTARTS=3          # nudge budget per rolling window
FLEET_RESTART_WINDOW_MS=3600000   # 1h rolling window / auto-close drain window

# --- behavior ---
FLEET_ALLOW_NUDGE=0           # 1 to enable safe STUCK nudges (paste-buffer only)
FLEET_PROTECTED=              # comma list of extra pane targets to protect
FLEET_AGENT_PATTERN=hermes    # regex to detect hermes panes in list-panes
```

Note: `FLEET_MAX_RESTARTS` / `FLEET_RESTART_WINDOW_MS` are the knobs added in
v0.3.1 — they let you widen or tighten the watchdog's restart budget at runtime
without editing code or the schema defaults.

## 2. systemd user service (`fleet-ctrl.service`)

Install as the `ubuntu` user:

```bash
mkdir -p ~/.config/systemd/user
cp fleet-ctrl.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now fleet-ctrl
```

For it to survive logout: `sudo loginctl enable-linger ubuntu`.

This is a *user* service; `WorkingDirectory` and paths assume the repo lives at
`~/projects/hermes-fleet-ctrl` and the build (`dist/cli.js`) is already present
(`pnpm run build`). Use `EnvironmentFile=` to pull in `fleet-env.example` instead
of inline `Environment=` lines if you prefer.
