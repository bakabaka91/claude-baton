# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.1.1] - 2026-03-25

### Changed
- Switch auto-checkpoint and daily summary LLM calls from Haiku to Sonnet for better quality

## [2.1.0] - 2026-03-25

### Added
- Auto-checkpoint chaining: each auto-checkpoint fetches previous checkpoint + git diff for richer context
- Allowed tools registration during setup for frictionless slash commands (no approval prompts)
- Resume resilience: `/memo-resume` shows source label (manual/auto) and diff intelligence since last checkpoint

### Fixed
- MCP server registration now uses `claude mcp add -s user` (correct discovery mechanism)
- PreCompact hook structure and MCP server stdio interference
- Auto-checkpoint stdin parsing and code quality improvements
- Dynamic MCP version read from package.json instead of hardcoded

## [2.0.0] - 2026-03-24

### Changed
- **Breaking:** Complete pivot from memory manager to session lifecycle manager
- Reduced from 18 MCP tools to 4 focused tools: `save_checkpoint`, `get_checkpoint`, `list_checkpoints`, `daily_summary`
- Reduced from 4 slash commands to 3: `memo-checkpoint`, `memo-resume`, `memo-eod`
- Simplified CLI: `setup`, `status`, `projects`, `export`, `import`, `reset`, `uninstall`
- Renamed package from memoria to claude-baton

### Added
- PreCompact hook for automatic checkpoint before context compaction
- `plan_reference` field on checkpoints for tracking active plan documents
- `source` field on checkpoints (`manual` | `auto`) to distinguish auto-checkpoints
- `uninstall` command for clean reversal of setup

### Removed
- Memory extraction, recall, consolidation, dead ends, constraints, goals, insights
- CLAUDE.md managed block sync
- RAG-style recall pipeline
- All Zod dependencies

## [1.0.0] - 2026-03-23

### Added
- 18 MCP tools: search, save, recall, stats, dead ends, constraints, goals, checkpoints, insights, daily summaries, consolidation, CLAUDE.md sync
- 4 slash commands: memo-checkpoint, memo-resume, memo-insight, memo-eod
- CLI with setup, status, search, projects, export, import, reset commands
- Automatic memory extraction from Claude Code session transcripts via hooks
- RAG-style recall with synthesized answers via `claude -p`
- Dead end tracking to avoid retrying failed approaches
- Constraint management for persistent project rules
- Session lifecycle: checkpoint before compact, resume at session start
- Consolidation: confidence decay, deduplication, LLM-assisted merging
- CLAUDE.md managed block with prioritized ordering (constraints first)
- Cross-project support via single SQLite database
- Zero API keys required (all LLM calls via `claude -p`)
