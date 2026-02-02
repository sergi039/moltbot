/**
 * Cross-platform glob matching utilities.
 * Used for browser upload path allowlists.
 */

import os from "node:os";
import path from "node:path";

/**
 * Check if the current platform has a case-insensitive filesystem by default.
 * - Windows: always case-insensitive
 * - macOS: case-insensitive by default (HFS+/APFS)
 * - Linux: case-sensitive
 */
export function isCaseInsensitivePlatform(): boolean {
  return process.platform === "win32" || process.platform === "darwin";
}

/**
 * Normalize a path for matching:
 * - Convert backslashes to forward slashes (Windows compatibility)
 * - Strip Windows extended path prefix (\\?\)
 * - Lowercase only on case-insensitive platforms (Windows, macOS)
 */
export function normalizePathForMatch(value: string): string {
  let result = value;
  if (process.platform === "win32") {
    // Strip Windows extended path prefix
    result = result.replace(/^\\\\[?.]\\/, "");
  }
  // Normalize backslashes to forward slashes
  result = result.replace(/\\/g, "/");
  // Lowercase only on case-insensitive platforms
  if (isCaseInsensitivePlatform()) {
    result = result.toLowerCase();
  }
  return result;
}

/**
 * Expand ~ to home directory in a path pattern.
 */
export function expandHome(pattern: string): string {
  if (!pattern.startsWith("~")) return pattern;
  const home = os.homedir();
  if (pattern === "~") return home;
  if (pattern.startsWith("~/") || pattern.startsWith("~\\")) {
    return path.join(home, pattern.slice(2));
  }
  return pattern;
}

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supports:
 * - ** matches zero or more path segments (including empty)
 * - * matches any characters EXCEPT path separators
 * - ? matches a single character
 *
 * Case sensitivity depends on platform:
 * - Windows/macOS: case-insensitive
 * - Linux: case-sensitive
 */
export function globToRegExp(pattern: string): RegExp {
  let regex = "^";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      const next = pattern[i + 1];
      if (next === "*") {
        // ** matches zero or more path segments
        // If followed by /, make the / optional (so **/x matches both x and a/x)
        if (pattern[i + 2] === "/") {
          regex += "(.*/)?";
          i += 3;
        } else {
          regex += ".*";
          i += 2;
        }
        continue;
      }
      // * matches anything except /
      regex += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      regex += ".";
      i += 1;
      continue;
    }
    // Escape regex special characters
    regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    i += 1;
  }
  regex += "$";
  // Case-insensitive only on case-insensitive platforms
  const flags = isCaseInsensitivePlatform() ? "i" : "";
  return new RegExp(regex, flags);
}

/**
 * Check if a file path matches a glob pattern.
 *
 * - Handles ~ expansion in patterns
 * - Normalizes paths for cross-platform compatibility
 * - Supports *, **, and ? wildcards
 *
 * @param pattern - Glob pattern (e.g., "/safe/**", "~/Downloads/*")
 * @param filePath - Absolute file path to check
 * @returns true if the path matches the pattern
 */
export function matchesGlobPattern(pattern: string, filePath: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) return false;

  // Expand ~ to home directory
  const expanded = expandHome(trimmed);

  // For non-wildcard patterns, also support directory prefix matching
  const hasWildcard = /[*?]/.test(expanded);
  if (!hasWildcard) {
    // Exact match or directory prefix
    const normalizedPattern = normalizePathForMatch(path.resolve(expanded));
    const normalizedPath = normalizePathForMatch(path.resolve(filePath));
    return (
      normalizedPath === normalizedPattern || normalizedPath.startsWith(normalizedPattern + "/")
    );
  }

  // Glob pattern matching
  const normalizedPattern = normalizePathForMatch(expanded);
  const normalizedPath = normalizePathForMatch(path.resolve(filePath));
  const regex = globToRegExp(normalizedPattern);
  return regex.test(normalizedPath);
}
