# Contributing to Hebrus Studio

## Setup

```sh
npm ci
npm run dev
```

Before submitting a change, run:

```sh
npm audit --audit-level=high
npm run typecheck
npm test
npm run build
```

Changes to Electron packaging, release identity, engine delivery, or bundled
files must also pass the arm64 package contract on macOS:

```sh
npm run pack:mac
npm run verify:mac -- "release/mac-arm64/Hebrus Studio.app"
```

## Runtime rules

- Never construct interpolated shell commands; always use an executable and an `argv` array.
- Keep the resolved `hebrus-server` or `ds4-server` compatibility command on
  `127.0.0.1`; LAN exposure is not part of the base profile.
- Do not add automatic CPU fallbacks on macOS.
- Do not send `SIGKILL` during normal shutdown. SIGTERM must give the engine
  time to drain requests and save KV state.
- Prefer the versioned `--capabilities=json` contract over source filenames,
  C symbols, diagnostics, or embedded-string probes. A malformed or unknown
  capability document fails closed; legacy probing remains limited to a
  pre-capability `ds4-server` during the compatibility window.
- Validate flags against `--help all` from the selected runtime. Managed
  ExpertMajor v2 startup must not reintroduce backend, power, residency,
  streaming, cache, preload, or cold-start overrides.
- Preserve the qualified hardware floors: 64 GiB for DeepSeek V4 Flash and
  GLM 5.2, and 16 GiB for Qwen3.6-35B-A3B. Require an immutable-revision,
  manifest-pinned ExpertMajor v2 GGUF whose filename, byte size, SHA-256, and
  minimum runtime commit match catalog metadata.
- Do not display Metal or I/O metrics that cannot be measured reliably.
- Treat traces and KV caches as potentially sensitive data.
- Never start a model download implicitly from the power action. Users must select a local GGUF or explicitly confirm a catalog download.
- Attribute model recommendations exclusively to Hebrus Studio, never to the repository or catalog author.

## UI

- Use only local assets and respect `prefers-reduced-motion`.
- Preserve keyboard navigation, accessible names, and an overflow-free layout at 430 px.
- Animations must clarify state changes, not conceal waits or errors.
- Make local-file selection and catalog downloads visibly distinct. Show the download size and destination before confirmation.
- Keep download cancellation visible while a transfer is active, and explain that partial downloads are resumable.

## Tests

Use fixtures or fake servers for logs, SSE, and process tests. Never start real model downloads in the test suite. Tests requiring a GGUF or the actual Metal backend must be separate and opt-in.

Freeze public catalog records as offline fixtures. Tests must not depend on a
mutable branch, the current Hugging Face response, or an unpinned download URL.
