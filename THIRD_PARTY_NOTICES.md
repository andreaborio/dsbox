# Third-party notices

Hebrus Studio is licensed under the terms in [`LICENSE`](LICENSE). That license
does not replace the licenses or notices of third-party software, services,
models, or data.

## JavaScript and desktop dependencies

The application uses open-source packages including Electron, React, React DOM,
Express, Vite, TypeScript, Framer Motion, Lucide, Zod, react-markdown,
remark-gfm, rehype-highlight, Vitest, and their transitive dependencies.
The exact dependency graph and versions are frozen in `package-lock.json`.

Package authors retain their copyrights and license terms. The authoritative
license for an installed package is its own package metadata and license file.
Before distributing a release, review the locked production dependency graph
and retain the Electron/Chromium notices emitted in the packaged application.

Useful release checks include:

```sh
npm ci
npm ls --omit=dev
npm audit --audit-level=high
```

The arm64 bundle includes Electron's `LICENSE.electron.txt` and
`LICENSES.chromium.html`; `scripts/verify-macos-release.sh` checks that those
packaged notices remain present.

## Hebrus engine

The inference engine is delivered externally and is not embedded in the
Hebrus Studio ASAR. Hebrus began as a fork of
[`antirez/ds4`](https://github.com/antirez/ds4) and retains substantial upstream
code and history. The engine also retains or adapts narrowly scoped code and
techniques from GGML/llama.cpp and bundled utilities under their respective
licenses. Refer to the engine's
[`ACKNOWLEDGMENTS.md`](https://github.com/andreaborio/hebrus/blob/main/ACKNOWLEDGMENTS.md)
and
[`THIRD_PARTY_NOTICES.md`](https://github.com/andreaborio/hebrus/blob/main/THIRD_PARTY_NOTICES.md)
for the authoritative source-level notices.

## External content and services

Model files, datasets, model repositories, model cards, and optional web-search
results are not licensed by this repository. Their providers' terms apply.
Hebrus Studio sends no model input to those services during local inference;
the privacy and opt-out behavior of optional web search is documented in the
README and security policy.
