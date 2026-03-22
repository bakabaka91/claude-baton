Prepare and create a pull request.

## Steps

1. **Pre-flight checks:**
   - Run `git status` to see all changes
   - Run `git diff` to review what changed
   - Verify no secrets or credentials in changed files

2. **Run tests:**
   - Run `npm run build` — must compile clean
   - Run `npm test` — all tests must pass
   - If either fails, fix issues before proceeding

3. **Run lint:**
   - Run `npx eslint src/ tests/ --ext .ts`
   - Run `npx prettier --check "src/**/*.ts" "tests/**/*.ts"`
   - Auto-fix if needed, then re-check

4. **Constraints verification:**
   - No new dependencies beyond the 4 allowed
   - No anthropic SDK imports
   - No native SQLite bindings
   - No SSE transport code
   - No git branch manipulation in source code

5. **Create PR:**
   - Stage relevant files
   - Create commit with descriptive message
   - Push branch
   - Create PR with summary, test plan, and constraints checklist
