## DSBox 0.2.3

This release makes the model library immediately clear: models DS4 can run stay
prominent, while incompatible Hugging Face sources remain available as quiet,
read-only references.

### What changed

- Split the catalog into a prominent DS4-ready group and a secondary reference
  group for unsupported repositories.
- Made the `DS4 ready` filter capability-based, so incomplete or unsupported
  non-Unsloth entries cannot appear as runnable models.
- Replaced full-size incompatible cards with compact neutral rows that show the
  exact compatibility reason and a source link, without misleading performance
  estimates or download controls.
- Added a dedicated `Other sources` view for provenance without mixing those
  repositories into the installable catalog.
- Kept local GGUF scanning, Finder selection, downloads, and runtime behavior
  unchanged.

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
