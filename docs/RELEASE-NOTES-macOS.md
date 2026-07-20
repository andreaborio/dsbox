## DSBox 0.2.8

This release adds one-click support for the single-file GLM-5.2 DS4
ExpertMajor v2 artifact while keeping its experimental runtime isolated from
the DS4 main line.

### GLM-5.2 ExpertMajor v2

- Recognizes the pinned `glm-dsa` metadata, tokenizer, 1,297-tensor inventory,
  and embedded `ds4.expert_major.v2` store during the lightweight GGUF header
  preflight; model weight payloads are not scanned.
- Enforces the 64 GB minimum and marks the artifact as **DS4 only** instead of
  implying compatibility with llama.cpp, MLX, or generic GGUF launchers.
- Selects and builds the dedicated
  `codex/glm52-upstream-clean-bench` runtime at qualified DS4 commit
  `08f3ebedcf000aadafe0b58211c571dd9dba14a8` or a verified descendant.
- Uses DS4 AUTO residency and the qualified GLM Metal profile without adding
  redundant SSD mode, full-layer, cache-size, or preload flags.
- Applies the same runtime check to catalog downloads, Finder selection, the
  local Library, and transactional model switches.

### Release safety

- A GLM file with changed geometry, tokenizer digests, routed-store extent,
  canonical routed tensors, or an unexpected tensor count is rejected before
  launch.
- The model manifest must pin one file, the ExpertMajor v2 format, the
  dedicated runtime branch, and an exact runtime commit.
- Experimental GLM remains outside the recommendation slot; existing Qwen and
  DeepSeek catalog behavior is unchanged.

### Verification

- Added header fixtures for valid and deliberately corrupted GLM contracts,
  catalog policy coverage, runtime-channel selection tests, and AUTO argument
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
