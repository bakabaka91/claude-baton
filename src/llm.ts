import { spawn } from "child_process";
import os from "os";

/**
 * Strip markdown code fences from LLM output.
 * LLMs frequently wrap JSON in ```json ... ``` blocks.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  // Match ```<optional language>\n...\n```
  const match = trimmed.match(/^```(?:\w*)\s*\n?([\s\S]*?)\n?\s*```$/);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

/**
 * Internal: spawns claude -p and returns the raw stdout string.
 * Used by both callClaude and callClaudeJson to avoid double-parse issues.
 */
function callClaudeRaw(
  prompt: string,
  model: string = "haiku",
  timeout: number = 30000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;

    // Strip Claude Code env vars so nested claude -p works from hooks
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    const proc = spawn(
      "claude",
      ["-p", "--model", model, "--output-format", "json"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        cwd: os.tmpdir(),
      },
    );

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      reject(new Error(`claude -p timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      if (process.env.CLAUDE_BATON_DEBUG) {
        console.error(
          `[DEBUG] claude -p exit=${code} stdout=${stdout.slice(0, 500)} stderr=${stderr.slice(0, 200)}`,
        );
      }
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
        return;
      }
      resolve(stdout);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    if (process.env.CLAUDE_BATON_DEBUG) {
      console.error(
        `[DEBUG] Prompt length: ${prompt.length}, first 300 chars: ${prompt.slice(0, 300)}`,
      );
    }
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

/**
 * Call claude -p and return the result as a string.
 * If the raw output is JSON with a `result` field, extracts it.
 * Always returns a string — non-string result values are JSON.stringified.
 */
export async function callClaude(
  prompt: string,
  model: string = "haiku",
  timeout: number = 30000,
): Promise<string> {
  const raw = await callClaudeRaw(prompt, model, timeout);
  const stripped = stripCodeFences(raw);
  try {
    const parsed = JSON.parse(stripped);
    const result = parsed.result ?? stripped;
    if (typeof result === "string") {
      return result;
    }
    return JSON.stringify(result);
  } catch {
    return stripped;
  }
}

/**
 * Call claude -p and parse the response as JSON of type T.
 * Uses the raw stdout (not the string-extracted callClaude) to avoid double-parse.
 */
export async function callClaudeJson<T>(
  prompt: string,
  model: string = "haiku",
  timeout: number = 30000,
): Promise<T> {
  const raw = await callClaudeRaw(prompt, model, timeout);
  const stripped = stripCodeFences(raw);
  try {
    const parsed = JSON.parse(stripped);
    // If the output has a `result` field, use that as the JSON value
    const value = parsed.result !== undefined ? parsed.result : parsed;
    // If value is already an object/array, return it directly
    if (typeof value === "object" && value !== null) {
      return value as T;
    }
    // If value is a string, try to parse it as JSON
    if (typeof value === "string") {
      return JSON.parse(stripCodeFences(value)) as T;
    }
    return value as T;
  } catch {
    throw new Error(
      `Failed to parse JSON from claude response: ${stripped.slice(0, 200)}`,
    );
  }
}
