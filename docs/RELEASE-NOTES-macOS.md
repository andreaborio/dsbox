## DSBox 0.2.7

This release adds explicit support for DS4 ExpertMajor model artifacts and
keeps their runtime boundary visible from discovery through local selection.

### DS4 ExpertMajor models

- Recognizes the native `ds4.expert_major.v1` Qwen and
  `ds4.expert_major.v2` DeepSeek tensor layouts during the lightweight GGUF
  preflight.
- Shows ExpertMajor files as **DS4 only** in Discover, the download review, and
  the local Library instead of presenting them as portable llama.cpp GGUFs.
- Requires ExpertMajor manifests to publish an exact format declaration and a
  pinned `andreaborio/ds4` runtime commit, with file checksums supplied by the
  pinned Hugging Face LFS metadata, before DSBox enables download.
- Prepares the unified ExpertMajor runtime before download and rechecks it for
  Finder, Library, and transactional live model switches.
- Keeps experimental artifacts out of the DSBox recommendation slot; the
  canonical checksum-pinned DeepSeek model remains the default.

### Repository rename continuity

- Supports manifest-declared previous Hugging Face repository ids, so an
  already-installed Qwen ExpertMajor bundle remains marked active after the
  repository receives its format-specific name.
- New downloads continue to use the current immutable repository revision;
  aliases are used only to recognize existing local paths.

### Verification

- Added catalog policy tests for exact v1/v2 format declarations, runtime pins,
  checksums, experimental status, and missing-contract failures.
- Added header-level fixtures for both layouts and verified the compatibility
  gate against the published-size 20.8 GB Qwen v1 and 86.7 GB DeepSeek v2
  artifacts without reading their weight payloads.

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
