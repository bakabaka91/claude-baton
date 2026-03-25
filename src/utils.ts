import { mkdirSync } from "fs";

// --- Path helpers ---

export function getProjectPath(): string {
  return process.cwd();
}

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}
