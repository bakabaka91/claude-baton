# claude-baton v2.0.1 — Bug Reports

Date: 2026-03-25

---

## Bug #1: MCP Server Registration Breaks Status Line Dashboard

**Severity:** Critical — breaks existing user functionality

### Problem

After running `claude-baton setup`, the user's `ccstatusline` status line dashboard disappears entirely. Removing the MCP server registration from `settings.json` immediately restores it.

### Reproduction

1. Have a working `statusLine` config in `~/.claude/settings.json`:
   ```json
   "statusLine": {
     "type": "command",
     "command": "ccstatusline",
     "padding": 0
   }
   ```
2. Run `claude-baton setup`
3. Restart Claude Code
4. Status line dashboard is gone — blank where it should be
5. Remove `mcpServers` block from settings.json → dashboard returns

### Root Cause

Unknown. The MCP server uses stdio transport. Both the MCP server (`npx -y claude-baton serve`) and the status line command use process communication with Claude Code. The MCP server process may be interfering with stdio routing, or `npx -y` may produce startup output that corrupts the channel.

### Affected Code

| File | Function | Issue |
|---|---|---|
| `src/cli.ts:164-169` | `handleSetup()` | Registers MCP server via `npx -y claude-baton serve` on stdio |

### Workaround

Remove the MCP server from `settings.json` manually, or run `claude-baton uninstall --keep-data`.

### Fix Required

Investigate why the MCP server process conflicts with the status line. Possible avenues:
- Check if the MCP server writes unexpected output to stdout/stderr during startup (before the MCP handshake)
- Check if `npx -y` itself produces output (download progress, version info) that interferes
- Test with a direct `node` path instead of `npx` to isolate whether `npx` is the problem
- Consider suppressing all output until the MCP protocol handshake completes

### Impact

Users who have a status line configured lose it after setup. This is a regression in existing functionality caused by installing claude-baton. The MCP tools still work if invoked manually, but the user experience is degraded.

---

## Bug #2: PreCompact Hook Produces Invalid Structure

**Severity:** Critical — the PreCompact auto-checkpoint hook never fires

### Problem

The `handleSetup()` function writes the PreCompact hook with a flat structure:

```json
"PreCompact": [
  {
    "type": "command",
    "command": "npx -y claude-baton auto-checkpoint"
  }
]
```

Claude Code expects the nested matcher + hooks structure:

```json
"PreCompact": [
  {
    "matcher": "",
    "hooks": [
      {
        "type": "command",
        "command": "npx -y claude-baton auto-checkpoint"
      }
    ]
  }
]
```

The hook silently does nothing on context compaction, and no checkpoints are ever saved automatically.

### How It Was Found

Compared the PreCompact hook structure to the working Stop hook in the same `settings.json` — the Stop hook correctly uses the `{matcher, hooks}` wrapper while PreCompact does not.

### Affected Code

| File | Lines | Function | Issue |
|---|---|---|---|
| `src/cli.ts` | 179-183 | `handleSetup()` | Pushes `{type, command}` directly into the array instead of wrapping in `{matcher, hooks: [...]}` |
| `src/cli.ts` | 176 | `handleSetup()` | `hasMemoriaHook` check uses `h.command.includes(...)` — assumes flat structure |
| `src/cli.ts` | 264-266 | `handleUninstall()` | Filters by `h.command` assuming flat structure — needs to check inside `h.hooks` array |

### Fix Required

**Setup — hook registration:**
```typescript
preCompactHooks.push({
  matcher: "",
  hooks: [
    {
      type: "command",
      command: "npx -y claude-baton auto-checkpoint",
    }
  ]
});
```

**Setup — idempotency check:**
```typescript
const hasMemoriaHook = preCompactHooks.some((h) =>
  h.hooks?.some((hook) => hook.command?.includes("claude-baton"))
);
```

**Uninstall — hook removal:**
```typescript
const filtered = preCompact.filter((h) =>
  !h.hooks?.some((hook) => hook.command?.includes("claude-baton"))
);
```

### Impact

The core value proposition of claude-baton (automatic checkpoint before compaction) is completely broken. Users who rely on the setup command get a non-functional hook. Manual `/memo-checkpoint` still works since it doesn't depend on the hook.

---

## Minor Issues (found during E2E testing)

### Issue #3: MCP Server Version Hardcoded — FIXED

**Severity:** Low
**Status:** Fixed in this session

The MCP server reported `version: "1.0.0"` while `package.json` is `2.0.1`. Fixed to read version from `package.json` dynamically.

### Issue #4: Stale Debug Env Var Name — FIXED

**Severity:** Low
**Status:** Fixed in this session

`src/llm.ts` referenced `MEMORIA_DEBUG` (old project name). Renamed to `CLAUDE_BATON_DEBUG`.
