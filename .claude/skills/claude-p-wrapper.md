# claude -p Wrapper Patterns

## Basic invocation

```typescript
import { spawn } from 'child_process';

async function callClaude(
  prompt: string,
  model: string = 'haiku'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', model, '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result || stdout);
      } catch {
        resolve(stdout.trim());
      }
    });

    // Send prompt via stdin
    proc.stdin.write(prompt);
    proc.stdin.end();

    // Timeout after 30 seconds
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error('claude -p timed out after 30s'));
    }, 30000);

    proc.on('close', () => clearTimeout(timeout));
  });
}
```

## Usage for extraction

```typescript
async function extractMemories(chunk: string): Promise<ExtractedMemory[]> {
  const prompt = extractionPrompt.replace('{{CHUNK}}', chunk);
  const response = await callClaude(prompt, 'haiku');

  try {
    return JSON.parse(response);
  } catch {
    console.error('Failed to parse extraction response:', response);
    return [];
  }
}
```

## Usage for recall (RAG-style)

```typescript
async function recall(topic: string, relevantMemories: Memory[]): Promise<string> {
  const context = relevantMemories.map((m) => `- [${m.type}] ${m.content}`).join('\n');
  const prompt = recallPrompt
    .replace('{{TOPIC}}', topic)
    .replace('{{CONTEXT}}', context);

  return callClaude(prompt, 'sonnet'); // Use sonnet for synthesis
}
```

## Key rules
1. **Always use `claude -p`** — never import `@anthropic-ai/sdk` or call the API directly
2. **Use haiku** for extraction and consolidation (fast, cheap under subscription)
3. **Use sonnet** for recall/synthesis (needs higher quality)
4. **Always set a timeout** — LLM calls can hang
5. **Parse JSON defensively** — LLM output may not be valid JSON
6. **Stderr is informational** — claude -p writes progress to stderr, only stdout matters
7. **The `--output-format json` flag** returns structured output with a `result` field
