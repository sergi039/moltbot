/**
 * Redactor
 *
 * Applies redaction patterns to text and objects to remove sensitive information.
 */

import type { RedactionPattern, RedactionCategory } from "./patterns.js";
import { getEnabledPatterns } from "./patterns.js";

// ============================================================================
// Types
// ============================================================================

/**
 * Statistics about redaction operations.
 */
export interface RedactionStats {
  /** Total number of redactions made */
  totalRedactions: number;

  /** Redactions by pattern ID */
  byPattern: Record<string, number>;

  /** Redactions by category */
  byCategory: Record<RedactionCategory, number>;
}

/**
 * Result of a redaction operation.
 */
export interface RedactionResult<T> {
  /** The redacted content */
  redacted: T;

  /** Statistics about what was redacted */
  stats: RedactionStats;

  /** Whether any redaction was made */
  hasRedactions: boolean;
}

/**
 * Options for the redactor.
 */
export interface RedactorOptions {
  /** Custom patterns to use (defaults to DEFAULT_PATTERNS) */
  patterns?: RedactionPattern[];

  /** Whether to track statistics (default: true) */
  trackStats?: boolean;

  /** Custom replacement format function */
  formatReplacement?: (patternId: string, category: RedactionCategory) => string;
}

// ============================================================================
// Redactor Class
// ============================================================================

/**
 * Redactor that applies patterns to remove sensitive information.
 */
export class Redactor {
  private patterns: RedactionPattern[];
  private trackStats: boolean;
  private formatReplacement?: (patternId: string, category: RedactionCategory) => string;

  constructor(options: RedactorOptions = {}) {
    this.patterns = options.patterns ?? getEnabledPatterns();
    this.trackStats = options.trackStats ?? true;
    this.formatReplacement = options.formatReplacement;
  }

  /**
   * Redact sensitive information from a string.
   */
  redactString(text: string): RedactionResult<string> {
    const stats = this.createEmptyStats();
    let result = text;

    for (const pattern of this.patterns) {
      if (!pattern.enabled) continue;

      // Reset lastIndex for global patterns
      pattern.pattern.lastIndex = 0;

      // Count matches before replacement
      const matches = text.match(pattern.pattern);
      const matchCount = matches?.length ?? 0;

      if (matchCount > 0) {
        // Get replacement text
        const replacement = this.formatReplacement
          ? this.formatReplacement(pattern.id, pattern.category)
          : pattern.replacement;

        // Apply replacement
        result = result.replace(pattern.pattern, replacement);

        // Track stats
        if (this.trackStats) {
          stats.totalRedactions += matchCount;
          stats.byPattern[pattern.id] = (stats.byPattern[pattern.id] ?? 0) + matchCount;
          stats.byCategory[pattern.category] =
            (stats.byCategory[pattern.category] ?? 0) + matchCount;
        }
      }
    }

    return {
      redacted: result,
      stats,
      hasRedactions: stats.totalRedactions > 0,
    };
  }

  /**
   * Redact sensitive information from an object (deep).
   */
  redactObject<T>(obj: T): RedactionResult<T> {
    const stats = this.createEmptyStats();
    const redacted = this.redactValue(obj, stats);

    return {
      redacted: redacted as T,
      stats,
      hasRedactions: stats.totalRedactions > 0,
    };
  }

  /**
   * Convenience method to redact and return just the result.
   */
  redact<T>(value: T): T {
    if (typeof value === "string") {
      return this.redactString(value).redacted as T;
    }
    return this.redactObject(value).redacted;
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  private redactValue(value: unknown, stats: RedactionStats): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === "string") {
      const result = this.redactString(value);
      this.mergeStats(stats, result.stats);
      return result.redacted;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.redactValue(item, stats));
    }

    if (typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.redactValue(val, stats);
      }
      return result;
    }

    // Primitives (number, boolean, etc.) pass through
    return value;
  }

  private createEmptyStats(): RedactionStats {
    return {
      totalRedactions: 0,
      byPattern: {},
      byCategory: {} as Record<RedactionCategory, number>,
    };
  }

  private mergeStats(target: RedactionStats, source: RedactionStats): void {
    target.totalRedactions += source.totalRedactions;

    for (const [pattern, count] of Object.entries(source.byPattern)) {
      target.byPattern[pattern] = (target.byPattern[pattern] ?? 0) + count;
    }

    for (const [category, count] of Object.entries(source.byCategory)) {
      const cat = category as RedactionCategory;
      target.byCategory[cat] = (target.byCategory[cat] ?? 0) + count;
    }
  }
}

// ============================================================================
// Factory and Convenience Functions
// ============================================================================

/**
 * Default redactor instance.
 */
let defaultRedactor: Redactor | null = null;

/**
 * Get or create the default redactor.
 */
export function getDefaultRedactor(): Redactor {
  if (!defaultRedactor) {
    defaultRedactor = new Redactor();
  }
  return defaultRedactor;
}

/**
 * Create a new redactor with custom options.
 */
export function createRedactor(options?: RedactorOptions): Redactor {
  return new Redactor(options);
}

/**
 * Redact a string using the default redactor.
 */
export function redactString(text: string): string {
  return getDefaultRedactor().redactString(text).redacted;
}

/**
 * Redact an object using the default redactor.
 */
export function redactObject<T>(obj: T): T {
  return getDefaultRedactor().redactObject(obj).redacted;
}

/**
 * Redact any value using the default redactor.
 */
export function redact<T>(value: T): T {
  return getDefaultRedactor().redact(value);
}

/**
 * Redact with full stats using the default redactor.
 */
export function redactWithStats<T>(value: T): RedactionResult<T> {
  if (typeof value === "string") {
    return getDefaultRedactor().redactString(value) as RedactionResult<T>;
  }
  return getDefaultRedactor().redactObject(value);
}
