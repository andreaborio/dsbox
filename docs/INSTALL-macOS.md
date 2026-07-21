# Install Hebrus Studio on macOS

Hebrus Studio's public Apple Silicon DMG is published only after strict release
readiness confirms Developer ID signing, notarization, stapling, and a clean
Gatekeeper assessment. Version 0.4.0 remains a release candidate while those
gates are pending; this page describes the post-gate public installation.

## Install the public release

1. Download `SHA256SUMS.txt` and every file it names from the same GitHub
   release: the DMG, CycloneDX SBOM, third-party license inventory, and the
   upgrade/rollback JSON report and log.
2. In Terminal, verify the complete release set from that folder:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

3. Open the DMG and drag **Hebrus Studio** to **Applications**.
4. Eject the disk image. Run Hebrus Studio from **Applications**, not from the DMG.
5. Optionally confirm Gatekeeper acceptance before launch:

   ```sh
   spctl -a -vv -t exec "/Applications/Hebrus Studio.app"
   ```

## If Gatekeeper rejects the public app

Do not remove quarantine or use **Open Anyway** for a public Hebrus Studio
release. Recheck the complete checksum set, confirm that every file came from
the same release, and report the rejection with the version and `spctl` output.
A rejected public artifact has failed the release contract even if its checksum
matches.

## Local development build

Contributors may create an ad-hoc signed bundle for local testing. It is clearly
separate from the public release, carries development provenance, is rejected
by the release verifier, and must not be redistributed.

If Gatekeeper quarantines a local-development copy that you built yourself or
received through a trusted development channel, first Control-click the app in
Finder and choose **Open**. If macOS still blocks that same trusted app, remove
quarantine from that app only, then open it:

```sh
xattr -dr com.apple.quarantine "/Applications/Hebrus Studio.app"
open "/Applications/Hebrus Studio.app"
```

Never run a broad `xattr` command against `/Applications`. Never use this local
exception for a purported public release: the public DMG must pass Developer ID,
notarization, stapling, checksum, and Gatekeeper verification without a bypass.

## Upgrade from DSBox

`DSBox.app` and `Hebrus Studio.app` have different filesystem names, so Finder
will not replace the old bundle automatically. They share the same bundle ID,
control port, engine state, and Electron profile; never run them together.

1. Quit DSBox completely.
2. Install Hebrus Studio from the verified DMG.
3. Launch Hebrus Studio and verify your model inventory, settings, theme, and conversations.
4. Remove `DSBox.app`, or keep it offline only as a short-lived rollback copy.

Hebrus Studio deliberately continues to use `~/.dsbox` and
`~/Library/Application Support/DSBox`, so no data migration or duplication is
required. To roll back, quit Hebrus Studio before reopening the old app.

For later Hebrus Studio updates, quit the app and replace the existing
`Hebrus Studio.app` when Finder asks.
