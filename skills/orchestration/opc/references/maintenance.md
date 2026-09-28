# Package maintenance

Production is this skill; development/tests live in `development/opc-opn/` in the parent skills repository. Run its package test/check scripts, `scripts/validate-opc.mjs`, and the quick skill validator. Publish committed Git blobs through the repository manifest contract. Markdown link titles mark `runtime` dependencies or conditional `branch:<name>` references for instruction-path validation.

For an OPC 5 host cutover, retire the old gateway through the owning host's service manager before removing its script. Preserve unrelated services and unresolved legacy task evidence. Source publication alone is not host cutover.
