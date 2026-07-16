## DSBox 0.2.6

This patch makes long model downloads easier to follow and refreshes the public
product guide with current DSBox screens and agent behavior.

### Model download visibility

- When a model download starts or resumes, Models now scrolls the existing
  progress panel into view automatically.
- Progress updates do not repeatedly move the page, and keyboard focus remains
  where the user left it.
- Reopening Models while a download is active brings its progress back into
  view, with reduced-motion preferences respected.

### Documentation refresh

- Replaced the main product screenshots with a current seven-screen walkthrough
  of Chat, Models, Server, Agent mode, coding-agent connections, Activity, and
  selectable color palettes.
- Documented the boundary between DSBox's bounded built-in agent loop and
  external coding agents that own their own tools, permissions, and workspace.
- Clarified capability detection, Web search boundaries, tool limits, protocol
  availability, telemetry, and the current single-selected-model architecture.

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
