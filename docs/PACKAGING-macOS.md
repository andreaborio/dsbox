# macOS packaging contract

The public product name is Hebrus Studio. Compatibility identifiers remain
intentionally unchanged during the bridge release while the engine moves from
DS4 to Hebrus. `electron-builder.yml` remains the build authority;
`scripts/macos-package-contract.json` records the invariants enforced after the
artifact is built.

The community package is:

- `Hebrus Studio.app`, bundle identifier `com.dsbox.desktop`;
- versioned from `package.json`, with executable `Contents/MacOS/Hebrus Studio`;
- Apple Silicon (`arm64`) and ad-hoc signed;
- branded with the temporary H mark recorded in
  `scripts/macos-package-contract.json` while the final logo is replaced;
- an ASAR-packaged Electron UI and control plane;
- independent of engine delivery: no Hebrus or legacy DS4 executable is
  embedded. Hebrus Studio discovers and builds the compatible engine separately.

The repository does not claim Developer ID signing or notarization. Those are
separate release gates and must not be inferred from a successful community
package verification.

## Reproduce the verification

Build and inspect the unpacked application without creating a disk image:

```sh
npm ci
npm run typecheck
npm test
npm run build:icon
npm run pack:mac
npm run verify:mac -- "release/mac-arm64/Hebrus Studio.app"
```

Build and inspect the release disk image:

```sh
npm run dist:mac
npm run verify:mac
```

`npm run build:icon` reproducibly derives the macOS ICNS variants from the
temporary H mark without requiring a source logo asset. The web UI renders the
same placeholder through the shared `BrandMark` component and theme-aware CSS.

The verifier checks the disk image when present, application and executable
names, canonical DMG filename, the current app icon byte for byte, bundle
identifier, package and bundle versions, exact architecture, ASAR header
integrity, packaged `package.json`, absence of embedded engine executables,
checksum when required by the release lane, and the sealed ad-hoc code
signature.

An optional launch smoke uses disposable Hebrus Studio state and Electron user-data
directories:

```sh
DSBOX_VERIFY_LAUNCH=1 npm run verify:mac -- "release/mac-arm64/Hebrus Studio.app"
```

This confirms that the packaged control plane reaches `/api/health`. It does
not download a model or qualify inference.

The `DSBOX_VERIFY_*` names are retained compatibility controls. The packaged
app also pins Electron `userData` to `~/Library/Application Support/DSBox` and
runtime state to `~/.dsbox`. A release test must therefore cover an upgrade
from the old bundle and a process-exclusive rollback; `DSBox.app` and
`Hebrus Studio.app` must never run at the same time.

Run the packaged upgrade and rollback gate from a committed release candidate:

```sh
npm run verify:upgrade-rollback:e2e
```

The runner checks out the frozen DSBox 0.3.2 compatibility checkpoint and the
current commit into disposable worktrees, installs their locked dependencies,
and builds both real arm64 application bundles. It then launches exactly one
bundle at a time through the sequence DSBox -> Hebrus Studio -> DSBox, sharing
only an isolated Electron profile and an isolated `.dsbox` state root.

The gate proves that the packaged applications preserve the bundle identifier,
the legacy Electron profile contract, config, model inventory, download state,
and the `dsbox:*` keys for theme, onboarding, current view, model disclosure,
and chat history. Hebrus Studio also writes state that the rolled-back DSBox
package reads. Every control, DevTools, and configured engine port is allocated
on loopback outside port 8000; no inference process is started. A failed run
retains its disposable runtime directory and prints its location for diagnosis.

Use `DSBOX_UPGRADE_E2E_OLD_REF` or `DSBOX_UPGRADE_E2E_NEW_REF` only when
qualifying different committed checkpoints. To test two already-built bundles
without rebuilding them, invoke `scripts/verify-upgrade-rollback-e2e.mjs` with
`--old-app` and `--new-app` paths.

### Scope and deliberate limits

Both sides of this gate are real packaged applications, not source-level
substitutes. For safety, they receive the same explicit disposable
`--user-data-dir` instead of opening the developer's real default profile. The
gate separately inspects the packaged Hebrus Studio ASAR for the default
`DSBox` profile pin and checks the shared bundle identifier in both app plists.
It does not mutate a real `~/Library/Application Support/DSBox` directory.

The model-inventory sentinel is a tiny non-runnable `.gguf` file and the
download sentinel is a cancelled record. These verify persistence and schema
compatibility only. The gate intentionally performs no network download,
engine installation, model loading, or inference qualification.
