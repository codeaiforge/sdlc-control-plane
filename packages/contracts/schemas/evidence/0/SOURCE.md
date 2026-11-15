# Vendored: `evidence/0` JSON Schema

`evidence.schema.json` in this directory is a byte-for-byte copy of the engine's published schema.
Do not edit it here; replace it from a new engine tag and update this record in the same commit.

| Field  | Value                                                                                        |
| ------ | -------------------------------------------------------------------------------------------- |
| Source | `github.com/codeaiforge/git-native-sdlc-controls`, `schemas/evidence/0/evidence.schema.json` |
| Tag    | `v0.3.0` (commit `46f75eb9dacb0722d0dead9afd48bfea2d122dd5`)                                 |
| sha256 | `b383e63662215d80bf42d5ff607f235bcbb67dd6c5f95eaffaac45b3c2565d25`                           |

It is a reference, not the validator: `validateEvidence` in `../../../src/schema.mjs` checks the
minimum stable subset by hand. `packages/contracts/src/engine-schema-drift.test.mjs` fails when
this file's sha256 differs from the one recorded above, when the schema stops tolerating additive
fields, or when the subset requires a field this schema does not.
