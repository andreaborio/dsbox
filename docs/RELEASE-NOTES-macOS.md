## DSBox 0.2.0

This release turns DSBox into a more complete local-AI workspace for Apple
Silicon while keeping DS4 as the single inference engine.

### What is new

- A redesigned, lighter chat experience with persistent local threads,
  contextual model switching, optional reasoning, automatic scrolling,
  syntax-highlighted code, copy controls, and response-level prefill and decode
  statistics.
- Local GGUF discovery with persistent validated inventory, plus a native Finder
  picker for selecting a model without typing filesystem paths.
- In-app Hugging Face downloads from DSBox sources, including Unsloth GGUF
  repositories, resumable transfers, standard shard sets, multipart assembly,
  disk checks, and advisory hardware guidance.
- A cleaner server power flow, safer runtime transitions, explicit stop
  controls, and improved activity tracking so completed external requests do not
  remain stuck in a processing state.
- A new DSBox brand mark and macOS application icon, a shared design system, a
  refined thread sidebar, and a screenshot-led product README.
- Text-only gateway validation before requests reach DS4, while preserving the
  OpenAI Chat, Responses, and Anthropic-compatible loopback endpoints used by
  coding agents.

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
