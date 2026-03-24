import { mkdirSync, existsSync } from "fs";

// --- Path helpers ---

export function getProjectPath(): string {
  return process.cwd();
}

export function ensureDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}
