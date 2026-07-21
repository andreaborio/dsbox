## Scope

Describe the user-visible change and the application, engine-bridge, persisted
state, or packaging boundary it owns.

## Compatibility

- Which Hebrus Studio and Hebrus/DS4 versions were exercised?
- Does this change config v2, localStorage, application-data paths, model
  manifests, binary discovery, repository identity, or bundle identity?
- What is the rollback behavior?

## Verification

- [ ] `npm audit --audit-level=high`
- [ ] `npm run check:brand`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run build`
- [ ] macOS package contract run when packaging or release contents changed
- [ ] packaged upgrade/rollback E2E run when persisted identity or state changed
- [ ] no real model download or private user data entered tests or fixtures

List any model-backed or packaged-app evidence separately. Do not present an
unsigned/ad-hoc package check as Developer ID signing or notarization evidence.
