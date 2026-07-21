# macOS packaging contract

The current DSBox package identity is intentionally unchanged while the engine
moves from DS4 to Hebrus. `electron-builder.yml` remains the build authority;
`scripts/macos-package-contract.json` records the invariants enforced after the
artifact is built.

The community package is:

- `DSBox.app`, bundle identifier `com.dsbox.desktop`;
- versioned from `package.json`, with executable `Contents/MacOS/DSBox`;
- Apple Silicon (`arm64`) and ad-hoc signed;
- an ASAR-packaged Electron UI and control plane;
- independent of engine delivery: no Hebrus or legacy DS4 executable is
  embedded. DSBox discovers and builds the compatible engine separately.

The repository does not claim Developer ID signing or notarization. Those are
separate release gates and must not be inferred from a successful community
package verification.

## Reproduce the verification

Build and inspect the unpacked application without creating a disk image:

```sh
npm ci
npm run typecheck
npm test
npm run pack:mac
npm run verify:mac -- release/mac-arm64/DSBox.app
```

Build and inspect the release disk image:

```sh
npm run dist:mac
npm run verify:mac
```

The verifier checks the disk image when present, application and executable
names, bundle identifier, package and bundle versions, exact architecture,
ASAR header integrity, packaged `package.json`, absence of embedded engine
executables, and the sealed ad-hoc code signature.

An optional launch smoke uses disposable DSBox state and Electron user-data
directories:

```sh
DSBOX_VERIFY_LAUNCH=1 npm run verify:mac -- release/mac-arm64/DSBox.app
```

This confirms that the packaged control plane reaches `/api/health`. It does
not download a model or qualify inference.
