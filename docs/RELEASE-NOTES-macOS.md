## DSBox 0.2.2

This release prevents generic GGUF files from being presented as DS4-compatible
models and adds a verified DS4-native one-click download.

### What changed

- Added a lightweight GGUF v3 preflight that reads metadata and the tensor
  directory without loading model weights or using the GPU.
- Applied the same compatibility gate to disk scans, Finder selection, model
  switching, completed downloads, persisted download resumes, and server start.
- Added specific errors for unsupported standard multipart GGUF files, missing
  DS4 metadata, unsupported architectures, and malformed containers.
- Kept current Unsloth repositories visible for provenance while disabling
  downloads for their unsupported standard multipart layout.
- Added the checksum-pinned DS4-native Q2 Imatrix model from the DwarfStar
  repository as an in-app download.
- Kept hardware guidance advisory: models larger than unified memory remain
  selectable, with an honest warning that SSD-streamed generation may be slow.

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
