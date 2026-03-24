Run through the acceptance verification checklist from PLAN.md.

## Verification Checklist

Test each item and report PASS/FAIL with details:

1. **Package install:** Can `npm pack && npm install -g *.tgz` succeed from the project root?
2. **Setup:** Does `claude-baton setup` create `~/.claude-baton/` and init SQLite?
3. **Hook config:** Does setup add hooks to `~/.claude/settings.json`?
4. **Memory extraction:** Start a session → Stop → are memories in SQLite?
5. **Search:** Does `claude-baton search "test query"` return relevant results?
6. **CLAUDE.md sync:** Does the managed block show constraints before decisions?
7. **Dead end check:** Does `check_dead_ends("approach X")` warn about known dead ends?
8. **Daily summary:** Does `daily_summary()` generate a coherent summary?

For items that can't be tested yet (requires running MCP server with Claude Code), note them as SKIP with reason.

## Report format
```
[PASS] 1. Package install — installed successfully
[FAIL] 2. Setup — ~/.claude-baton not created (error: ...)
[SKIP] 4. Memory extraction — requires live Claude Code session
```

Summary: X/8 PASS, Y/8 FAIL, Z/8 SKIP
