import { describe, it, expect } from "vitest";
import { normalizeProjectPath } from "../src/utils.js";

describe("normalizeProjectPath", () => {
  it("removes trailing slash", () => {
    const result = normalizeProjectPath("/Users/foo/bar/");
    expect(result).toBe("/Users/foo/bar");
  });

  it("preserves root path", () => {
    const result = normalizeProjectPath("/");
    expect(result).toBe("/");
  });

  it("resolves relative paths", () => {
    const result = normalizeProjectPath("./src/../src");
    expect(result).not.toContain("..");
    expect(result).not.toContain("./");
  });

  it("handles already-clean paths", () => {
    const result = normalizeProjectPath("/Users/foo/bar");
    expect(result).toBe("/Users/foo/bar");
  });
});
