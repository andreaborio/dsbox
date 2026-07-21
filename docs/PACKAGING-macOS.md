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
- branded from the unchanged 1254 x 1254 RGBA master at
  `src/assets/hebrus-logo.png` (SHA-256
  `4be8949c73bd52e7abef58396dcd57f636165a8bb6cd6d536a600bcbf880594c`);
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

`npm run build:icon` refuses a modified logo master and reproducibly derives the
macOS ICNS variants without editing the source PNG. The web UI loads that same
PNG and adds depth only at render time with CSS `drop-shadow()`.

The verifier checks the disk image when present, application and executable
names, canonical DMG filename, the master-derived icon byte for byte, bundle
identifier, package and bundle versions, exact architecture, ASAR header
integrity, the exact embedded logo SHA-256, packaged `package.json`, absence of
embedded engine executables, checksum when required by the release lane, and
the sealed ad-hoc code signature.

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
