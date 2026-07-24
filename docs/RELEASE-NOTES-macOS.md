# Hebrus Studio 0.4.0

This is the candidate for the first public **Hebrus Studio** bridge release. It
renames the DSBox desktop experience and presents the inference engine as
**Hebrus**, while deliberately preserving every persistent and wire-level
identifier needed by existing installations. It is not published until the
external release gates below are complete.

## Identity and upgrade safety

- Uses the candidate artifact names `Hebrus Studio.app` and
  `Hebrus-Studio-0.4.0-macOS-arm64.dmg`; publication remains blocked by the
  readiness interlock below.
- Uses the project-supplied Hebrus PNG unchanged in the README and application;
  web depth is a CSS-only drop shadow, and the macOS icon is generated from the
  same hash-frozen master during packaging.
- Retains `com.dsbox.desktop`, `~/.dsbox`,
  `~/Library/Application Support/DSBox`, `DSBOX_*`, `dsbox:*` local-storage
  keys, control headers, SSE identifiers, and the `ds4-server` fallback.
- Accepts both Hebrus and legacy DS4 runtime identities and fails closed on
  malformed capability documents.
- Documents the non-replacing Finder upgrade: quit DSBox, install and verify
  Hebrus Studio, never run both bundles together, then remove the old app or
  keep it offline only for rollback.
- Adds a real packaged-app gate for DSBox -> Hebrus Studio -> DSBox rollback,
  using disposable state and profiles and no model inference. It verifies that
  legacy settings, model/download inventory, theme, onboarding, view, model
  disclosure, and conversation state remain readable in both directions.
- Bundles the project license, project third-party notices, Electron license,
  and Chromium notice set as verifier-enforced release contents.

## Runtime and model contract

- Prefers `hebrus-server` and falls back to `ds4-server` during the bridge.
- Preserves published model filenames, `dsbox.json`, `DS4EXPV2`,
  `ds4.expert_major.v2`, and `DS4_*` variables; no weight is renamed or
  republished for the product rename.
- Pins the Qwen3.6 35B A3B MLX affine4/group-64 ExpertMajor v2 artifact by
  revision, filename, byte size, SHA-256, and minimum runtime commit.
- Pins that minimum to the merged Hebrus commit containing the guarded
  3,521-expert cache ceiling and phase-pressure gate. The Hebrus Studio release
  gate must run the reported travel prompt on a
  physical M5 24 GiB host with thinking `medium` and `high` under Studio's
  configured 16,384-token candidate context, record the seed, and separately
  sustain decode beyond 1,719 generated tokens for each setting. Natural
  responses and a subsequent request in the same server must finish with no
  pressure `WARNING`, new swapout, watchdog `SIGTERM`, or stream failure.
- Keeps the app text-only and the control plane loopback-only.

## Packaging status

Local development bundles are arm64 and ad-hoc signed. They carry explicit
development provenance, are rejected by the release verifier, and are not the
future public download. The public lane requires Developer ID signing,
notarization, stapling, and clean-machine Gatekeeper verification before its
strict gates can become ready; public instructions do not prescribe a
Gatekeeper bypass.

Public publication is mechanically blocked while
`scripts/public-release-readiness.json` contains a pending gate. The release
workflow runs strict readiness before building, so creating a `v0.4.0` tag today
cannot publish this candidate. Normal CI uses status mode and continues to test
the source while reporting the pending work.

After every gate is evidenced, the release workflow will generate provenance
from the clean exact tagged commit and embed it in both the app and the
versioned `Hebrus-Studio-0.4.0-SBOM.cdx.json`. A protected `public-release`
environment binds the exact certificate common name, SHA-1, and Apple team to
provenance and both final signatures. The workflow records the current accepted
notary submission in a persistent release attestation. SBOM normalization fills
npm's missing license fields only from installed, lockfile-resolved package
metadata and expands every lockfile path, including nested duplicate
coordinates; the release fails if any component, edge, or identifiable license
is missing and also publishes a path-aware third-party license inventory.

The compatibility E2E then mounts the app from the final DMG instead of
building a second Hebrus package, writes an atomic hash-bound JSON report and
log, and validates them. Only after that gate passes does `SHA256SUMS.txt` cover
the DMG, signing/notarization attestation, SBOM, license inventory, E2E report,
and E2E log. No such asset or public binary is claimed as published while
readiness remains blocked.

## Historical release notes

### DSBox 0.3.2

This closeout release pins Hebrus Studio to DwarfStar v0.2.0 at
`8015bd39a8d81ebfb997e3955117f481e946a962` and tightens the public model
contract without adding startup flags.

### Release hardening

- Requires at least 64 GiB unified memory in the live catalog, download
  readiness, local startup, and hardware guidance.
- Requires one complete ExpertMajor v2 GGUF whose declared filename, byte size,
  and SHA-256 match the revision-pinned Hugging Face LFS metadata.
- Keeps model path, context, output limit, thread count, loopback bind, port,
  working directory, and CORS policy authoritative even when advanced arguments
  contain conflicting short, long, or `--option=value` forms.
- Removes retired ExpertMajor tuning variables from managed launch environments.
- Keeps the 0.3.1 DS4 AUTO command shape. Qwen and DeepSeek select residency
  adaptively; GLM selects its SSD profile. GLM 32K remains available because it
  completed the release gate on the 64 GiB host, although it is a slow test.
- Corrects the example DeepSeek artifact SHA-256 and pins all release metadata
  to the same DS4 runtime commit.

### Verification

- Live Hugging Face catalog checked at 64 and 32 GiB.
- TypeScript, production build, theme guard, and the complete automated suite
  rerun after the final runtime and manifest pins.

### DSBox 0.3.1

This release completes the ExpertMajor v2-only startup contract for Qwen3.6,
DeepSeek V4 Flash, and GLM-5.2. All three families now use one DS4 `main`
checkout and let DS4 AUTO choose the backend and resident-or-SSD plan from the
validated model and live Mac memory state.

### Unified startup

- Uses only `~/.dsbox/runtime/andreaborio-ds4` on branch `main`; historical
  model-specific checkouts are no longer selected automatically.
- Requires DS4 commit
  `7c99924f93c4be46d065421c46e1541b29bd28dd` or a verified descendant.
- Omits backend, power, residency, streaming, cache, preload, cold-start, and
  warm-up overrides on managed models. DeepSeek retains disk-KV, imatrix,
  steering, and optional prefill controls. GLM retains disk-KV while its graph
  owns prefill and currently omits imatrix/steering. Qwen hides the session
  features its recurrent runtime cannot serialize and owns its prefill schedule.
- Filters retired or conflicting advanced arguments consistently across Qwen,
  DeepSeek, and GLM while retaining safe server and diagnostic arguments.
- Shows DS4 AUTO consistently in Runtime, Settings, and Monitor instead of
  inferring a false in-memory mode from the intentionally minimal command.
- Pins the current DeepSeek ExpertMajor v2 filename, size, and SHA-256 in the
  example Hebrus Studio manifest.

### Release safety

- A GLM file with changed geometry, tokenizer digests, routed-store extent,
  canonical routed tensors, or an unexpected tensor count is rejected before
  launch.
- The model manifest must pin one file, the ExpertMajor v2 format, DS4 `main`,
  and an exact runtime commit.
- Older GLM files, sidecars, layout revisions, and retired tuning modes are not
  accepted as compatibility fallbacks.
- Qwen, DeepSeek, and GLM catalog downloads all require the same ExpertMajor v2
  manifest and unified-runtime gate.

### Verification

- Retained header fixtures for valid and deliberately corrupted ExpertMajor v2
  contracts, catalog policy coverage, main-runtime selection tests, and
  table-driven AUTO argument tests for all three model families.
- Passed 298 automated tests, TypeScript checks, and the production build.

### Historical community-build policy

The preceding desktop release used an ad-hoc signed Apple Silicon package and
manual first-launch approval. That historical policy does not apply to the
future Hebrus Studio public download: its strict gate requires Developer ID,
notarization, stapling, and Gatekeeper acceptance before publication.
