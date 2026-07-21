## DSBox 0.3.2

This closeout release pins DSBox to DwarfStar v0.2.0 at
`57acfd408a3154851a0c59be432904300abb3b6c` and tightens the public model
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

## DSBox 0.3.1

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
  example DSBox manifest.

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

### macOS community build

The attached application is built for Apple Silicon and requires macOS 13 or
later.

> [!IMPORTANT]
> The app is ad-hoc signed for bundle integrity, but it is not signed with an
> Apple Developer ID and is not notarized. macOS will require one explicit
> approval on first launch. Read the attached installation guide before opening
> the app.

The release workflow verifies the DMG, validates the complete app bundle and
checks the arm64 architecture before publishing. Compare your download against
the attached `SHA256SUMS.txt` file.

### Install

1. Download the DMG, `SHA256SUMS.txt`, and `INSTALL-macOS.md`.
2. Verify the checksum.
3. Drag DSBox to Applications.
4. Control-click DSBox and choose Open, or use Privacy & Security → Open Anyway.
