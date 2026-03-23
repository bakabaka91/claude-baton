# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
