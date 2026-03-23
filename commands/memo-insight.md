Capture a real-time insight immediately.

Usage: `/memo-insight chose merge commits over squash to preserve granular history`

## Steps

1. Take $ARGUMENTS as the raw insight text. If $ARGUMENTS is empty, ask the user what insight to capture.

2. Determine the category from the content:
   - "decision" -- choices between alternatives
   - "workflow" -- process/technique observations
   - "architecture" -- structural/design insights
   - "surprise" -- unexpected findings (default if unclear)
   - "cost" -- efficiency/cost observations

3. Call the `save_insight` MCP tool with:
   - content: $ARGUMENTS
   - category: the determined category
   - context: current file or feature being worked on, if obvious from session context

4. Confirm: "Insight saved. Keep going."
