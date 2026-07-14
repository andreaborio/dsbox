# Install DSBox on macOS

DSBox is distributed as an Apple Silicon DMG. The current community build is
ad-hoc signed for bundle integrity, but it is not signed with an Apple Developer
ID and is not notarized. macOS will therefore ask you to approve it once.

## Install

1. Download `DSBox-<version>-macOS-arm64.dmg` and `SHA256SUMS.txt` from the same
   GitHub release.
2. In Terminal, verify the download from the folder containing both files:

   ```sh
   shasum -a 256 -c SHA256SUMS.txt
   ```

3. Open the DMG and drag **DSBox** to **Applications**.
4. Eject the disk image. Run DSBox from **Applications**, not from the DMG.
5. Control-click **DSBox**, choose **Open**, then confirm **Open**. This exception
   applies only to this copy of DSBox.

If macOS does not show the second **Open** button, first try launching DSBox once,
then open **System Settings → Privacy & Security**, scroll to **Security**, and
choose **Open Anyway**.

## If macOS says the app is damaged

First verify the SHA-256 checksum as shown above. If it matches the release and
you trust this repository, remove quarantine from this app only, then launch it:

```sh
xattr -dr com.apple.quarantine /Applications/DSBox.app
open /Applications/DSBox.app
```

Do not run a broad `xattr` command against `/Applications`, and do not bypass
Gatekeeper for an artifact whose checksum does not match.

## Update

Quit DSBox, install the newer DMG, and replace the existing application when
Finder asks. Models, settings, and local conversations are stored outside the
application bundle and remain in place.
