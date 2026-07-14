## DSBox 0.2.1

This patch removes DeepSeek-specific promotional copy from the general DSBox
experience and simplifies decorative UI elements.

### What changed

- Removed the `DeepSeek V4 Flash · on your Mac` promotional row from the empty
  chat state.
- Removed every decorative star and sparkle icon from the interface.
- Kept model recommendations as plain, readable status labels.
- Replaced DeepSeek-centric engine and coding-agent descriptions with neutral
  DS4 wording.
- Fixed catalog fallback IDs so an unknown compatible model is no longer
  mislabeled as DeepSeek.

Actual DeepSeek model names still appear when that model is selected or listed
as a real Hugging Face source; DSBox itself remains model-agnostic.

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
