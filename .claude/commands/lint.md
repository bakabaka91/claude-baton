Run linting and formatting checks:

1. Run `npx eslint src/ tests/ --ext .ts` to check for lint errors
2. Run `npx prettier --check "src/**/*.ts" "tests/**/*.ts"` to check formatting
3. If lint errors exist, run `npx eslint src/ tests/ --ext .ts --fix` to auto-fix
4. If format errors exist, run `npx prettier --write "src/**/*.ts" "tests/**/*.ts"` to auto-fix
5. Re-run both checks to verify clean
6. Report: errors found, auto-fixed, remaining
