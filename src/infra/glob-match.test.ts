import { describe, expect, it } from "vitest";
import {
  normalizePathForMatch,
  globToRegExp,
  matchesGlobPattern,
  isCaseInsensitivePlatform,
} from "./glob-match.js";

const IS_CASE_INSENSITIVE = isCaseInsensitivePlatform();

describe("normalizePathForMatch", () => {
  it("converts backslashes to forward slashes", () => {
    const result = normalizePathForMatch("C:\\Users\\test\\file.txt");
    expect(result).toContain("/");
    expect(result).not.toContain("\\");
  });

  it("lowercases only on case-insensitive platforms", () => {
    const result = normalizePathForMatch("/Users/Test/FILE.TXT");
    if (IS_CASE_INSENSITIVE) {
      expect(result).toBe("/users/test/file.txt");
    } else {
      expect(result).toBe("/Users/Test/FILE.TXT");
    }
  });

  it("handles mixed slashes", () => {
    const result = normalizePathForMatch("/Users\\test/Mixed\\path");
    expect(result).toContain("/");
    expect(result).not.toContain("\\");
  });
});

describe("globToRegExp", () => {
  it("* matches anything except /", () => {
    const regex = globToRegExp("/safe/*.txt");
    expect(regex.test("/safe/file.txt")).toBe(true);
    expect(regex.test("/safe/nested/file.txt")).toBe(false);
  });

  it("** matches anything including /", () => {
    const regex = globToRegExp("/safe/**");
    expect(regex.test("/safe/file.txt")).toBe(true);
    expect(regex.test("/safe/nested/deep/file.txt")).toBe(true);
  });

  it("? matches a single character", () => {
    const regex = globToRegExp("/safe/file?.txt");
    expect(regex.test("/safe/file1.txt")).toBe(true);
    expect(regex.test("/safe/fileAB.txt")).toBe(false);
  });

  it("escapes regex special characters", () => {
    const regex = globToRegExp("/safe/file[1].txt");
    expect(regex.test("/safe/file[1].txt")).toBe(true);
    expect(regex.test("/safe/file1.txt")).toBe(false);
  });

  it("handles ** followed by specific path", () => {
    const regex = globToRegExp("/safe/**/file.txt");
    expect(regex.test("/safe/file.txt")).toBe(true);
    expect(regex.test("/safe/nested/file.txt")).toBe(true);
    expect(regex.test("/safe/nested/deep/file.txt")).toBe(true);
    expect(regex.test("/safe/other.txt")).toBe(false);
  });

  it("* does NOT match across directory boundaries", () => {
    const regex = globToRegExp("/safe/*/x");
    expect(regex.test("/safe/dir/x")).toBe(true);
    expect(regex.test("/safe/any/other/x")).toBe(false);
    expect(regex.test("/safe/any/other/file")).toBe(false);
  });
});

describe("matchesGlobPattern", () => {
  it("matches exact paths", () => {
    expect(matchesGlobPattern("/safe/file.txt", "/safe/file.txt")).toBe(true);
    expect(matchesGlobPattern("/safe/file.txt", "/safe/other.txt")).toBe(false);
  });

  it("matches directory prefix (non-wildcard)", () => {
    expect(matchesGlobPattern("/safe", "/safe/file.txt")).toBe(true);
    expect(matchesGlobPattern("/safe", "/safe/nested/file.txt")).toBe(true);
    expect(matchesGlobPattern("/safe", "/unsafe/file.txt")).toBe(false);
  });

  it("handles * wildcard", () => {
    expect(matchesGlobPattern("/safe/*.txt", "/safe/file.txt")).toBe(true);
    expect(matchesGlobPattern("/safe/*.txt", "/safe/nested/file.txt")).toBe(false);
  });

  it("handles ** wildcard", () => {
    expect(matchesGlobPattern("/safe/**", "/safe/file.txt")).toBe(true);
    expect(matchesGlobPattern("/safe/**", "/safe/nested/deep/file.txt")).toBe(true);
    expect(matchesGlobPattern("/safe/**/*.txt", "/safe/nested/file.txt")).toBe(true);
  });

  it("handles ~ expansion", () => {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    expect(matchesGlobPattern("~", `${home}/file.txt`)).toBe(true);
    expect(matchesGlobPattern("~/Downloads", `${home}/Downloads/file.txt`)).toBe(true);
  });

  it("case sensitivity depends on platform", () => {
    // On case-insensitive platforms (Windows, macOS): /Safe/File.TXT matches /safe/file.txt
    // On case-sensitive platforms (Linux): they do NOT match
    expect(matchesGlobPattern("/Safe/File.TXT", "/safe/file.txt")).toBe(IS_CASE_INSENSITIVE);
  });

  it("handles Windows-style paths", () => {
    // Pattern and path both get normalized, so this should work
    expect(matchesGlobPattern("C:\\Users\\test", "C:\\Users\\test\\file.txt")).toBe(true);
  });

  it("rejects empty patterns", () => {
    expect(matchesGlobPattern("", "/any/path")).toBe(false);
    expect(matchesGlobPattern("   ", "/any/path")).toBe(false);
  });

  it("/safe/*/x does NOT allow /safe/any/other/file", () => {
    // Critical test case from the review
    expect(matchesGlobPattern("/safe/*/x", "/safe/dir/x")).toBe(true);
    expect(matchesGlobPattern("/safe/*/x", "/safe/any/other/file")).toBe(false);
    expect(matchesGlobPattern("/safe/*/x", "/safe/any/other/x")).toBe(false);
  });
});
