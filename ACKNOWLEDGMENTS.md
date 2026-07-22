# Acknowledgments

Hebrus Studio is an open-source desktop application built around an
open-source inference lineage. These credits record technical provenance; they
do not imply endorsement, sponsorship, or an official partnership.

## Hebrus engine lineage

Hebrus Studio prepares, launches, and observes the Hebrus inference engine.
Hebrus began as a fork of
[`antirez/ds4`](https://github.com/antirez/ds4) and retains substantial core
implementation, architecture, utilities, and Git history from that project.
Salvatore Sanfilippo (antirez) and the upstream contributors created the
foundation on which the engine's Metal, embedded ExpertMajor, and SSD streaming
paths continue to evolve.

The engine repository is the authority for exact code provenance. Its
[`ACKNOWLEDGMENTS.md`](https://github.com/andreaborio/ds4/blob/main/ACKNOWLEDGMENTS.md),
[`THIRD_PARTY_NOTICES.md`](https://github.com/andreaborio/ds4/blob/main/THIRD_PARTY_NOTICES.md),
and fork ledger identify retained code, engineering references, and the current
boundary from upstream.

## Engine references

[`llama.cpp`](https://github.com/ggml-org/llama.cpp) and
[`GGML`](https://github.com/ggml-org/ggml) are important references for GGUF,
quantization, kernels, converters, and validation methods in Hebrus.
[`MLX`](https://github.com/ml-explore/mlx) and MLX-LM informed the qualified
Qwen affine storage and validation work. These projects are not embedded in
Hebrus Studio as its inference engine, and this credit makes no endorsement
claim.

## Desktop application ecosystem

Hebrus Studio is built with Electron, React, Express, Vite, TypeScript, and a
number of smaller open-source packages. Icons are provided by Lucide. Markdown
and syntax rendering use the unified/remark/rehype and highlight.js ecosystems.
Dependency versions are locked in `package-lock.json`; license terms remain
those of each package and are not replaced by the Hebrus Studio license. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Models and services

The project depends intellectually on the researchers and open-weight model
teams behind Qwen, DeepSeek, and GLM, and on the wider Metal, GGUF, and local
inference communities. Model weights, model cards, datasets, Hugging Face
repositories, and optional DuckDuckGo Lite search have their own terms and
privacy boundaries.

## Visual identity

The Hebrus logo is the maintainer-supplied canonical master. The checked-in PNG
is preserved byte-for-byte; Hebrus Studio adds its web shadow only at render
time with CSS and derives the macOS icon reproducibly from the same master.
