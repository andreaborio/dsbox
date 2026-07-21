# macOS packaging contract

The public product name is Hebrus Studio. Compatibility identifiers remain
intentionally unchanged during the bridge release while the engine moves from
DS4 to Hebrus. `electron-builder.yml` is the Developer ID, hardened-runtime,
app-notarization release authority; `electron-builder.dev.yml` is the explicit
ad-hoc local override. `scripts/macos-package-contract.json` records the
invariants enforced after each artifact is built.

The local development package is:

- `Hebrus Studio.app`, bundle identifier `com.dsbox.desktop`;
- versioned from `package.json`, with executable `Contents/MacOS/Hebrus Studio`;
- Apple Silicon (`arm64`) and ad-hoc signed;
- branded with the temporary H mark recorded in
  `scripts/macos-package-contract.json` while the final logo is replaced;
- an ASAR-packaged Electron UI and control plane;
- bundled project, third-party, Electron, and Chromium legal notices;
- independent of engine delivery: no Hebrus or legacy DS4 executable is
  embedded. Hebrus Studio discovers and builds the compatible engine separately.

That ad-hoc package is never the public download. The public lane cannot pass
strict readiness until Developer ID signing, notarization, stapling, and
Gatekeeper verification are implemented and evidenced. Public installation
documentation therefore never asks users to bypass Gatekeeper.

The release workflow also refuses to continue without `CSC_LINK`,
`CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and
`APPLE_TEAM_ID`. The release job is attached to the `public-release` GitHub
Environment. Configure that environment with required reviewers, prevent
self-review, restrict deployment tags to the approved `v*` policy, and store
all five credentials there rather than as unreviewed repository secrets.

The same environment must define protected variables
`HEBRUS_SIGNING_CERTIFICATE_COMMON_NAME`,
`HEBRUS_SIGNING_CERTIFICATE_SHA1`, and `HEBRUS_SIGNING_TEAM_ID`. They must
exactly match the common name, leaf-certificate SHA-1 fingerprint, and ten
character Apple team identifier recorded by the ready `developer-id-signing`
gate. Strict readiness rejects a mismatch, provenance records the authorized
identity, `APPLE_TEAM_ID` must equal the protected team variable, and both the
app and DMG are inspected after signing to prove they use that exact leaf
certificate and team. A merely well-formed Developer ID signature is not
sufficient.

After electron-builder signs and notarizes the app, the
workflow verifies the signed outer DMG, submits that DMG to `notarytool`,
staples it, and validates the ticket. The release verifier then checks the DMG
Developer ID authority/team and stapling before mounting it, and checks the
mounted app's Developer ID, hardened runtime, and Gatekeeper assessment.

## Public-release interlock

[`scripts/public-release-readiness.json`](../scripts/public-release-readiness.json)
is the machine-readable authority for external launch readiness. It currently
marks all required gates `ready: false` and `status: pending`: naming and legal
approval, private vulnerability reporting, private conduct intake, Developer
ID signing, notarization and stapling, hosted CI on the exact release commit,
and model-backed qualification of exact Studio and engine commits.

Inspect the truthful status without failing normal development or CI:

```sh
npm run release:readiness
```

The release workflow uses the fail-closed mode before `dist:mac` or any
`gh release create` command:

```sh
npm run release:readiness:strict
```

Strict mode rejects pending gates, incomplete evidence, mismatched version or
state fields, missing exact-commit attestations, and signing/notarization claims
that still conflict with the package configuration. Do not set a gate ready
from intent alone; record the evidence fields described by the checker and keep
the protected release attestations aligned with the tagged `GITHUB_SHA`.

After strict mode passes—and before `dist:mac`—the tag workflow runs
`scripts/generate-release-provenance.mjs`. It fails unless the checkout is
clean, `GITHUB_SHA` equals `HEAD`, `GITHUB_REF_NAME` is the package-version tag,
that tag resolves to the same commit, and the run is a tagged GitHub Actions
push. The resulting `build/release-provenance.json` is embedded at
`Contents/Resources/release-provenance.json`. The package verifier requires its
commit and tag to match the release run; the SBOM records the same commit, tag,
provenance-file SHA-256, and release-attestation SHA-256. Provenance also binds
the reviewed readiness-manifest hash, exact signing identity, and the prior
notarization qualification submission.

## Signing and notarization attestation

The `notarization-stapling` readiness evidence contains the UUID of the real
qualification run reviewed before launch. It is intentionally not the UUID of
the future release submission: Apple creates a new submission UUID when the
tagged final DMG is uploaded. The workflow captures `notarytool` with
`--output-format json`, requires the current result to be `Accepted`, then writes
`Hebrus-Studio-<version>-Release-Attestation.json` after stapling.

That persistent evidence contains the current submission UUID, final stapled
DMG hash, embedded-provenance hash, source commit/tag, and the actual app and
DMG certificate common name, SHA-1, and team. Its validator requires both
signatures to equal the identity authorized in provenance. The SBOM and
upgrade/rollback report bind the attestation hash, and the final checksum set
includes the attestation itself.

## Release SBOM

Only after strict readiness passes, the release workflow runs `npm sbom`
against the complete `package-lock.json` and emits
`Hebrus-Studio-<version>-SBOM.cdx.json`. The full lockfile graph is intentional:
it includes runtime, Electron, build, and test dependencies rather than hiding
the packaged Electron runtime because npm classifies it as a development
dependency.

The normalization step changes npm's checkout-directory-derived root name to
the canonical `hebrus-studio` identity, adds the exact `package-lock.json` and
provenance bindings, and fills missing component licenses only from installed
`package.json` metadata reached through the locked package paths. SPDX
expressions are parsed; unknown, missing, ambiguous, or non-identifiable values
stop the release instead of being replaced with guesses.

`scripts/validate-release-sbom.mjs` enforces the versioned filename, CycloneDX
1.5 identity, component references, complete dependency set, Electron presence,
lockfile/provenance/attestation hashes, and an identifiable license on every
component. Every non-root `package-lock.packages` path becomes one component
with a unique path-derived `bom-ref`, so nested duplicate name/version
occurrences cannot collapse into one row. Dependency nodes and resolved edges
must exactly match the path-aware lockfile graph; deleting a transitive
occurrence or edge stops the release.
The same validated data produces
`Hebrus-Studio-<version>-THIRD-PARTY-LICENSES.md`, a publishable sorted inventory.
Neither asset is claimed as published while readiness remains blocked.

## Local development package

Create an ad-hoc bundle for local testing:

```sh
npm ci
npm run typecheck
npm test
npm run build:icon
npm run pack:mac
npm run verify:mac:dev -- "release/mac-arm64/Hebrus Studio.app"
npm run dist:mac:dev
npm run verify:mac:dev -- "release/Hebrus-Studio-0.4.0-macOS-arm64.dmg"
npm run verify:upgrade-rollback:e2e:dev-dmg
```

Development provenance is deliberately not valid release provenance, so
`npm run verify:mac` rejects this package; `verify:mac:dev` validates its
explicit development provenance and the remaining package invariants. Exact release verification belongs
to the tagged workflow and cannot be reproduced by pretending a local build is
a hosted, approved artifact.

When Gatekeeper quarantines a trusted, locally built ad-hoc copy, contributors
should first Control-click the app in Finder and choose **Open**. If macOS still
blocks that same trusted app, they may remove quarantine from
`/Applications/Hebrus Studio.app` only:

```sh
xattr -dr com.apple.quarantine "/Applications/Hebrus Studio.app"
open "/Applications/Hebrus Studio.app"
```

This is a local-development exception, not a public install path. Never apply a
broad quarantine removal to `/Applications`, and never use the exception for a
public release artifact.

`verify:upgrade-rollback:e2e:dev-dmg` is a separate, non-release final-DMG
qualification lane. It requires the already-built DMG to embed development
provenance for the exact current commit (`tag: null`, `treeState: development`,
and the `local-development` provider/workflow). It builds only the frozen DSBox
checkpoint, mounts that DMG read-only, and runs DSBox -> Hebrus Studio -> DSBox.

The atomic outputs are
`release/development-evidence/Hebrus-Studio-<version>-Development-Upgrade-Rollback-E2E.json`
and the matching `.log`. Both are visibly non-release; the report binds the DMG,
embedded provenance, log, legacy commit, and current commit. The development
validator rejects release provenance, release-shaped evidence, changed files,
and evidence outside `release/development-evidence/`. These files are excluded
from the SBOM, `SHA256SUMS.txt`, the release workflow, and publication.

`npm run build:icon` reproducibly derives the macOS ICNS variants from the
temporary H mark without requiring a source logo asset. The web UI renders the
same placeholder through the shared `BrandMark` component and theme-aware CSS.

The release verifier checks the disk image when present, application and executable
names, canonical DMG filename, the current generated icon byte for byte, bundle
identifier, package and bundle versions, exact architecture, ASAR header
integrity, packaged `package.json`, absence of embedded engine executables, the
four required legal-notice files, embedded
exact-commit provenance, the exact final checksum set, and the configured code
signature. Release mode requires Developer ID, hardened runtime, a stapled DMG,
and Gatekeeper acceptance; development mode separately requires the ad-hoc
identity and rejects release authorization.

An optional launch smoke uses disposable Hebrus Studio state and Electron user-data
directories:

```sh
DSBOX_VERIFY_LAUNCH=1 npm run verify:mac:dev -- "release/mac-arm64/Hebrus Studio.app"
```

This confirms that the packaged control plane reaches `/api/health`. It does
not download a model or qualify inference.

The `DSBOX_VERIFY_*` names are retained compatibility controls. The packaged
app also pins Electron `userData` to `~/Library/Application Support/DSBox` and
runtime state to `~/.dsbox`. A release test must therefore cover an upgrade
from the old bundle and a process-exclusive rollback; `DSBox.app` and
`Hebrus Studio.app` must never run at the same time.

Run the source-checkpoint compatibility gate used by normal CI:

```sh
npm run verify:upgrade-rollback:e2e -- --source
```

That runner checks out the frozen DSBox 0.3.2 compatibility checkpoint and the
current commit into disposable worktrees, installs their locked dependencies,
and builds both real arm64 application bundles. It then launches exactly one
bundle at a time through the sequence DSBox -> Hebrus Studio -> DSBox, sharing
only an isolated Electron profile and an isolated `.dsbox` state root.

The tag workflow uses the stricter release lane after the final DMG and SBOM
already exist:

```sh
npm run verify:upgrade-rollback:e2e -- --release
```

It builds only the frozen legacy side, mounts the already-built final DMG
read-only, and runs the Hebrus phase from that mounted app. It atomically writes
a versioned JSON report and log containing the final DMG, attestation, and SBOM
hashes, source commit/tag, embedded provenance hash, current notary submission,
frozen legacy commit, and tested sequence.
The report is independently validated before checksums are generated.

The gate proves that the packaged applications preserve the bundle identifier,
the legacy Electron profile contract, config, model inventory, download state,
and the `dsbox:*` keys for theme, onboarding, current view, model disclosure,
and chat history. Hebrus Studio also writes state that the rolled-back DSBox
package reads. Every control, DevTools, and configured engine port is allocated
on loopback outside port 8000; no inference process is started. A failed run
retains its disposable runtime directory and prints its location for diagnosis.

Use `DSBOX_UPGRADE_E2E_OLD_REF` or `DSBOX_UPGRADE_E2E_NEW_REF` only in the
source-checkpoint lane when qualifying different committed checkpoints. To test
two already-built bundles without release evidence, invoke
`scripts/verify-upgrade-rollback-e2e.mjs` with `--old-app` and `--new-app` paths.

## Final checksum set

Only after the final-DMG E2E passes does the workflow create `SHA256SUMS.txt`.
The checksum contract requires exactly the DMG, SBOM, license inventory, E2E
JSON report, E2E log, and signing/notarization attestation. The package verifier
validates both the exact filename set and every digest before `gh release
create` can run.

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
