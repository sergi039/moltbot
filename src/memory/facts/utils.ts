/**
 * Facts Memory Utilities
 *
 * Helper functions for the facts memory system.
 */

import { randomUUID } from "node:crypto";

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate a unique memory ID.
 */
export function generateMemoryId(): string {
  return `mem-${randomUUID().slice(0, 8)}`;
}

// ============================================================================
// Date Utilities
// ============================================================================

/**
 * Get current Unix timestamp in seconds.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Get today's date in YYYY-MM-DD format.
 */
export function getTodayDate(): string {
  return new Date().toISOString().split("T")[0];
}

/**
 * Format a Unix timestamp to ISO string.
 */
export function formatTimestamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

/**
 * Parse a date string to Unix timestamp in seconds.
 */
export function parseDate(dateStr: string): number {
  return Math.floor(new Date(dateStr).getTime() / 1000);
}

// ============================================================================
// Text Utilities
// ============================================================================

/**
 * Truncate text to a maximum length with ellipsis.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

/**
 * Normalize whitespace in text.
 */
export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Extract the first sentence from text.
 */
export function firstSentence(text: string): string {
  const match = text.match(/^[^.!?]*[.!?]/);
  return match ? match[0].trim() : truncate(text, 100);
}

/**
 * Count approximate tokens in text.
 * Uses a simple heuristic: ~4 characters per token.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ============================================================================
// JSON Utilities
// ============================================================================

/**
 * Safe JSON parse with fallback.
 */
export function safeJsonParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}

/**
 * Safe JSON stringify.
 */
export function safeJsonStringify(obj: unknown): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return "{}";
  }
}

// ============================================================================
// Validation Utilities
// ============================================================================

/**
 * Check if a value is a non-empty string.
 */
export function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Check if a value is a number in range.
 */
export function isNumberInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && value >= min && value <= max;
}

/**
 * Clamp a number to a range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ============================================================================
// Array Utilities
// ============================================================================

/**
 * Remove duplicates from an array.
 */
export function unique<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/**
 * Chunk an array into smaller arrays.
 */
export function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Group array items by a key function.
 */
export function groupBy<T, K extends string | number>(
  arr: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const item of arr) {
    const key = keyFn(item);
    if (!result[key]) {
      result[key] = [];
    }
    result[key].push(item);
  }
  return result;
}

// ============================================================================
// Security Utilities
// ============================================================================

/**
 * Mask sensitive data in text (API keys, tokens, etc.).
 */
export function maskSensitiveData(text: string): string {
  // Mask API keys
  let masked = text.replace(/sk-[a-zA-Z0-9-]{20,}/g, "sk-***");
  masked = masked.replace(/sk-ant-[a-zA-Z0-9-]{40,}/g, "sk-ant-***");

  // Mask tokens
  masked = masked.replace(/Bearer [a-zA-Z0-9._-]+/gi, "Bearer ***");

  // Mask passwords in common formats
  masked = masked.replace(/(password|pwd|passwd)[\s:=]+['"]?[^\s'"]+['"]?/gi, "$1: ***");

  return masked;
}

/**
 * Check if text contains sensitive data patterns.
 */
export function containsSensitiveData(text: string): boolean {
  const patterns = [
    /sk-[a-zA-Z0-9-]{20,}/, // OpenAI keys
    /sk-ant-[a-zA-Z0-9-]{40,}/, // Anthropic keys
    /ghp_[a-zA-Z0-9]{36}/, // GitHub PAT
    /-----BEGIN.*KEY-----/, // Private keys
    /(password|secret|token|api.?key)[\s:=]/i, // Common patterns
  ];

  return patterns.some((p) => p.test(text));
}

// ============================================================================
// Error Handling Utilities
// ============================================================================

/**
 * Wrap a function to catch and log errors.
 */
export function safeCall<T>(fn: () => T, fallback: T, logger?: (err: unknown) => void): T {
  try {
    return fn();
  } catch (err) {
    logger?.(err);
    return fallback;
  }
}

/**
 * Wrap an async function to catch and log errors.
 */
export async function safeCallAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  logger?: (err: unknown) => void,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger?.(err);
    return fallback;
  }
}
