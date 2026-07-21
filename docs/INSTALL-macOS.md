# Install Hebrus Studio on macOS

Hebrus Studio is distributed as an Apple Silicon DMG. The current community build is
ad-hoc signed for bundle integrity, but it is not signed with an Apple Developer
ID and is not notarized. macOS will therefore ask you to approve it once.

## Install

1. Download `Hebrus-Studio-<version>-macOS-arm64.dmg` and `SHA256SUMS.txt` from the same
   GitHub release.
2. In Terminal, verify the download from the folder containing both files:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

3. Open the DMG and drag **Hebrus Studio** to **Applications**.
4. Eject the disk image. Run Hebrus Studio from **Applications**, not from the DMG.
5. Control-click **Hebrus Studio**, choose **Open**, then confirm **Open**. This exception
   applies only to this copy of Hebrus Studio.

If macOS does not show the second **Open** button, first try launching Hebrus Studio once,
then open **System Settings → Privacy & Security**, scroll to **Security**, and
choose **Open Anyway**.

## If macOS says the app is damaged

First verify the SHA-256 checksum as shown above. If it matches the release and
you trust this repository, remove quarantine from this app only, then launch it:

```sh
xattr -dr com.apple.quarantine "/Applications/Hebrus Studio.app"
open "/Applications/Hebrus Studio.app"
```

Do not run a broad `xattr` command against `/Applications`, and do not bypass
Gatekeeper for an artifact whose checksum does not match.

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
