# Governance

## Project model

Hebrus Studio uses a lightweight maintainer model. Repository write and release
permissions are the factual source of maintainer authority; this document does
not create a foundation, committee, honorary role, or voting body.

Maintainers are responsible for reviewing changes, protecting compatibility
and security, accepting architectural decisions, managing releases, and
coordinating private vulnerability reports. That authority does not override
project licenses or permit removal of authorship and attribution.

## Contributions and decisions

Anyone may propose a change through a pull request. The scope and evidence rules
in [`CONTRIBUTING.md`](CONTRIBUTING.md) apply to every change. Reviewers may ask
for a narrower patch, stronger tests, a compatibility fixture, or independent
verification before merge.

Routine reversible choices can be settled in pull-request review. Changes to
bundle identity, persisted state, engine capability admission, model formats,
security boundaries, or release policy require a written compatibility plan
and the applicable packaged and model-backed evidence.

## Releases and security

A maintainer may publish a release only after the documented source, package,
upgrade/rollback, dependency, and security gates pass on the exact release
commit. Local qualification or an `Unreleased` changelog entry is not a
published release.

Undisclosed vulnerabilities follow [`SECURITY.md`](SECURITY.md) and must not be
posted with details in public issues. Private vulnerability reporting and a
private conduct-reporting route must be enabled and tested before public launch.

## Conduct and changes to governance

Community participation follows [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md).
Governance changes use the same public pull-request and review process as other
repository changes and require a maintainer with the corresponding permissions
to merge them.
