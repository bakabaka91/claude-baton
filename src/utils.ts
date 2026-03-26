import { mkdirSync, realpathSync } from "fs";
import path from "path";

// --- Path helpers ---

export function getProjectPath(): string {
  return process.cwd();
}

export function normalizeProjectPath(p: string): string {
  try {
    const resolved = realpathSync(p);
    return resolved.length > 1 && resolved.endsWith(path.sep)
      ? resolved.slice(0, -1)
      : resolved;
  } catch {
    const normalized = path.resolve(p);
    return normalized.length > 1 && normalized.endsWith(path.sep)
      ? normalized.slice(0, -1)
      : normalized;
  }
}

export function ensureDir(dirPath: string): void {
  mkdirSync(dirPath, { recursive: true });
}

// --- Formatting helpers ---

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
