import { spawn } from 'child_process';

export async function callClaude(
  prompt: string,
  model: string = 'haiku',
  timeout: number = 30000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', ['-p', '--model', model, '--output-format', 'json'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    proc.stderr.on('data', (data: Buffer) => {
      stderr += data.toString();
    });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`claude -p timed out after ${timeout}ms`));
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`claude -p exited with code ${code}: ${stderr}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        resolve(parsed.result ?? stdout);
      } catch {
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Failed to spawn claude: ${err.message}`));
    });

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export async function callClaudeJson<T>(
  prompt: string,
  model: string = 'haiku',
  timeout: number = 30000,
): Promise<T> {
  const response = await callClaude(prompt, model, timeout);
  try {
    return JSON.parse(response) as T;
  } catch {
    throw new Error(`Failed to parse JSON from claude response: ${response.slice(0, 200)}`);
  }
}
