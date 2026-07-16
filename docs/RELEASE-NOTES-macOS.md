## DSBox 0.2.5

This release expands Qwen and agent workflows and refreshes the DSBox desktop
interface with clearer state, safer navigation, and selectable color palettes.

### Runtime and agent upgrades

- Added Qwen runtime support and model identities, and moved Qwen execution to
  the mainline Metal AUTO runtime configuration.
- Added dual-model agent chat with explicit Web search control and more robust,
  request-gated automatic search.
- Fixed stale startup and capability states, improved legacy model responses,
  and removed a redundant DeepSeek catalog mirror.

### Interface and reliability

- Added an Appearance picker with Follow system, DSBox Light, DSBox Dark, Nord,
  and Solarized Dark. Theme changes apply immediately, persist across launches,
  and never restart the local model.
- Applied the saved appearance before React renders and extended semantic tokens
  across application chrome, code surfaces, terminals, selections, scrollbars,
  overlays, and charts.
- Reworked the Server power control into one clear action and made Agents report
  Offline, Starting, or Ready from the actual runtime and readiness state.
- Clarified Activity so host telemetry stays distinct from runtime metrics, and
  response speed appears only when DSBox has measured it.
- Added explicit live-update connection states. After a sustained SSE
  interruption, DSBox warns that visible values may be out of date while it
  reconnects automatically.
- Protected unsaved engine settings when leaving Settings, with Cancel, Discard,
  and Save options, including restart handling when the runtime is active.
- Improved first-run onboarding with dialog semantics, keyboard focus handling,
  Escape support, and an explicit Continue without a model choice.
- Kept unavailable or incompatible models collapsed by default while preserving
  session preference and temporarily revealing search matches.
- Restored the last open page, preloaded views after startup, replaced the
  generic loading message with stable skeletons, and refined sidebar labels,
  disabled-state explanations, tooltips, and collapsed chat controls.

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
