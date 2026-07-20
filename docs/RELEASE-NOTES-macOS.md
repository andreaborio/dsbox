## DSBox 0.3.0

This breaking release makes ExpertMajor v2 the only runnable MoE format for
Qwen3.6, DeepSeek V4 Flash, and GLM-5.2. It moves all three families onto the
unified DS4 `main` runtime, removes legacy Qwen flags and branches, and selects
only revision-pinned v2 files from the consolidated Hugging Face repositories.

### GLM-5.2 ExpertMajor v2

- Recognizes the pinned `glm-dsa` metadata, tokenizer, 1,297-tensor inventory,
  and embedded `ds4.expert_major.v2` store during the lightweight GGUF header
  preflight; model weight payloads are not scanned.
- Enforces the 64 GB minimum and marks the artifact as **DS4 only** instead of
  implying compatibility with llama.cpp, MLX, or generic GGUF launchers.
- Selects and builds DS4 `main` at qualified commit
  `fe0919b70571678408f2c8c52aec8d49525e715c` or a verified descendant.
- Uses DS4's automatic SSD/cache plan and qualified GLM Metal profile without
  adding redundant SSD mode, full-layer, cache-size, or preload flags.
- Reuses the unified ExpertMajor checkout and removes the obsolete GLM branch
  selector from Settings.
- Applies the same runtime check to catalog downloads, Finder selection, the
  local Library, and transactional model switches.

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

- Retained header fixtures for valid and deliberately corrupted GLM contracts,
  catalog policy coverage, main-runtime selection tests, and AUTO argument
  tests.
- Verified the real 262,147,193,504-byte internal GGUF through the same
  lightweight preflight used by DSBox.

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
