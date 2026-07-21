# Changelog

This file records user-visible Hebrus Studio changes. Detailed installation and
packaging notes live under `docs/`; unreleased entries do not represent a
published GitHub release.

## Unreleased

### Added

- Introduced the Hebrus Studio public identity, logo, launch UI, screenshots,
  documentation, and reproducible arm64 macOS icon.
- Added capability-based Hebrus engine discovery with a narrowly scoped legacy
  `ds4-server` fallback.
- Added checksum-aware macOS packaging verification for bundle identity,
  architecture, ASAR contents, logo, icon, external-engine delivery, and
  ad-hoc signature state.
- Added a packaged DSBox -> Hebrus Studio -> DSBox upgrade/rollback E2E using a
  disposable legacy profile and state root.
- Added security, contribution, governance, conduct, provenance, and
  third-party documentation plus structured issue and pull-request templates.

### Changed

- Visible product copy now says Hebrus Studio and identifies Hebrus as the
  external inference engine.
- The app prefers `hebrus-server`, accepts both current and pre-rename engine
  repository identities, and keeps malformed capability documents fail-closed.
- The model catalog and UI distinguish qualified Hebrus ExpertMajor artifacts
  from generic GGUF files.

### Compatibility

- The bundle identifier remains `com.dsbox.desktop`.
- The legacy `~/.dsbox` root, Electron DSBox profile, `DSBOX_*` environment
  variables, config v2, browser-storage keys, model paths, downloads, and
  gateway authentication remain readable for upgrade and rollback.
- No model file, KV data, or user state is renamed or copied for branding.
- The community macOS package is ad-hoc signed and is not notarized.
