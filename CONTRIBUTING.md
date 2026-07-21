# Contributing to DSBox

## Setup

```sh
npm ci
npm run dev
```

Before submitting a change, run:

```sh
npm run typecheck
npm test
npm run build
```

## Runtime rules

- Never construct interpolated shell commands; always use an executable and an `argv` array.
- Keep `ds4-server` on `127.0.0.1`; LAN exposure is not part of the base profile.
- Do not add automatic CPU fallbacks on macOS.
- Do not send `SIGKILL` during normal shutdown. SIGTERM must give ds4 time to drain requests and save KV state.
- Validate flags against `ds4-server --help all` from the unified `main` runtime; managed ExpertMajor v2 startup must not reintroduce backend, power, residency, streaming, cache, preload, or cold-start overrides.
- Keep release admission at 64 GiB unified memory or above, and require one manifest-pinned ExpertMajor v2 GGUF whose byte size and SHA-256 match Hugging Face metadata.
- Do not display Metal or I/O metrics that cannot be measured reliably.
- Treat traces and KV caches as potentially sensitive data.
- Never start a model download implicitly from the power action. Users must select a local GGUF or explicitly confirm a catalog download.
- Attribute model recommendations exclusively to DSBox, never to the repository or catalog author.

## UI

- Use only local assets and respect `prefers-reduced-motion`.
- Preserve keyboard navigation, accessible names, and an overflow-free layout at 430 px.
- Animations must clarify state changes, not conceal waits or errors.
- Make local-file selection and catalog downloads visibly distinct. Show the download size and destination before confirmation.
- Keep download cancellation visible while a transfer is active, and explain that partial downloads are resumable.

## Tests

Use fixtures or fake servers for logs, SSE, and process tests. Never start real model downloads in the test suite. Tests requiring a GGUF or the actual Metal backend must be separate and opt-in.
