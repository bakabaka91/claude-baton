import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "events";

// Mock child_process before importing llm
vi.mock("child_process", () => {
  return {
    spawn: vi.fn(),
  };
});

import { spawn } from "child_process";
import { callClaude, callClaudeJson } from "../src/llm.js";

const mockSpawn = vi.mocked(spawn);

function createMockProcess(
  stdout: string,
  stderr: string,
  exitCode: number,
  delay: number = 0,
) {
  const proc = new EventEmitter() as ReturnType<typeof spawn>;
  const stdoutEmitter = new EventEmitter();
  const stderrEmitter = new EventEmitter();
  const stdinEmitter = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    writable: true,
    destroy: vi.fn(),
    cork: vi.fn(),
    uncork: vi.fn(),
    setDefaultEncoding: vi.fn(),
  });

  (proc as unknown as Record<string, unknown>).stdout = stdoutEmitter;
  (proc as unknown as Record<string, unknown>).stderr = stderrEmitter;
  (proc as unknown as Record<string, unknown>).stdin = stdinEmitter;
  (proc as unknown as Record<string, unknown>).kill = vi.fn();

  setTimeout(() => {
    if (stdout) stdoutEmitter.emit("data", Buffer.from(stdout));
    if (stderr) stderrEmitter.emit("data", Buffer.from(stderr));
    setTimeout(() => proc.emit("close", exitCode), delay);
  }, 1);

  return proc;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("callClaude", () => {
  it("returns parsed JSON result field", async () => {
    const proc = createMockProcess(
      JSON.stringify({ result: "Hello from Claude" }),
      "",
      0,
    );
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await callClaude("test prompt");
    expect(result).toBe("Hello from Claude");
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--model", "haiku", "--output-format", "json"],
      expect.objectContaining({ stdio: ["pipe", "pipe", "pipe"] }),
    );
  });

  it("returns raw stdout when JSON parsing fails", async () => {
    const proc = createMockProcess("plain text response", "", 0);
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await callClaude("test prompt");
    expect(result).toBe("plain text response");
  });

  it("rejects on non-zero exit code", async () => {
    const proc = createMockProcess("", "error occurred", 1);
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    await expect(callClaude("test")).rejects.toThrow("exited with code 1");
  });

  it("rejects on timeout", async () => {
    const proc = createMockProcess("", "", 0, 5000);
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    await expect(callClaude("test", "haiku", 10)).rejects.toThrow("timed out");
  });

  it("uses specified model", async () => {
    const proc = createMockProcess(JSON.stringify({ result: "ok" }), "", 0);
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    await callClaude("test", "sonnet");
    expect(mockSpawn).toHaveBeenCalledWith(
      "claude",
      ["-p", "--model", "sonnet", "--output-format", "json"],
      expect.anything(),
    );
  });
});

describe("callClaudeJson", () => {
  it("returns typed JSON", async () => {
    const data = [{ type: "memory", content: "test" }];
    const proc = createMockProcess(
      JSON.stringify({ result: JSON.stringify(data) }),
      "",
      0,
    );
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await callClaudeJson<typeof data>("test");
    expect(result).toEqual(data);
  });

  it("throws on invalid JSON response", async () => {
    const proc = createMockProcess(
      JSON.stringify({ result: "not json at all" }),
      "",
      0,
    );
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    await expect(callClaudeJson("test")).rejects.toThrow(
      "Failed to parse JSON",
    );
  });
});
