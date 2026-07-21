# Security policy

## Local attack surface

DSBox is designed for a single user on the same Mac:

- control plane: `127.0.0.1:4242`;
- internal Hebrus/DS4 compatibility server: `127.0.0.1:8000` by default;
- the control plane does not support binding to `0.0.0.0`;
- CORS is not enabled on the runtime;
- an anti-CSRF header is required for mutating `/api/*` requests;
- API-key authentication is optional on the `/v1/*` gateway.

Do not expose these ports to the Internet. Use an authenticated tunnel for remote access.

## Sensitive data

ds4 traces can contain requests, rendered prompts, outputs, and tool calls. KV checkpoints can contain prompt text. Before sharing logs or a support bundle:

1. disable tracing unless it is required;
2. inspect the files manually;
3. remove source code, secrets, personal paths, and conversations;
4. do not publish `~/.dsbox/config.json` if it contains a gateway token that is also used elsewhere.

## Reporting a vulnerability

The project intends to receive reports through GitHub private vulnerability
reporting:

<https://github.com/andreaborio/dsbox/security/advisories/new>

Private vulnerability reporting is not asserted as enabled yet. Enabling and
testing it is an administrative launch gate. Until it is available, open only
a minimal public issue asking the repository owner for a private channel; do
not include vulnerability details, reproduction steps, logs, tokens, private
data, or attachments.

Include the exact DSBox version or commit, macOS version, hardware, installation
method, engine build identity, and a minimal reproduction in a private report.
Do not attach model weights, config files containing gateway keys, raw chat
history, traces, or KV checkpoints.
