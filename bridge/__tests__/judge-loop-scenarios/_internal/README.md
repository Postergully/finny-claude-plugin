# Internal Scenarios

These scenarios reference `finny_executeSuiteQL`, which was removed from
the public MCP tool surface in M4.1 (2026-05-13). The handler still
exists in `src/mcp/tools/executeSuiteQL.ts` and is unit-tested at
`src/__tests__/mcp/tools/executeSuiteQL.test.ts`, but cowork can no longer
invoke it.

These scenarios are kept for reference — if a future supervised-path
re-introduces the tool (e.g., for ops-only debugging), update and
restore them to the parent directory.
