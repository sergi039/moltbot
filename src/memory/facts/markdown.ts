/**
 * Facts Memory Markdown Sync
 *
 * Import/export memory data to/from Markdown files.
 * Maintains MEMORY.md for human-readable memory state.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { FactsMemoryStore } from "./store.js";
import type { MemoryBlock, MemoryBlockLabel, MemoryEntry, DailySummary } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

const MEMORY_FILE = "MEMORY.md";
const DAILY_DIR = "daily";

// ============================================================================
// Main Memory File
// ============================================================================

/**
 * Generate MEMORY.md content from store.
 */
export function generateMemoryMarkdown(store: FactsMemoryStore): string {
  const lines: string[] = [];

  // Header
  lines.push("# Memory");
  lines.push("");
  lines.push(`> Last updated: ${new Date().toISOString()}`);
  lines.push("");

  // Memory blocks
  const blocks = store.getAllBlocks();
  const blockOrder: MemoryBlockLabel[] = ["persona", "user_profile", "active_context"];

  for (const label of blockOrder) {
    const block = blocks.find((b) => b.label === label);
    if (block && block.value.trim()) {
      lines.push(`## ${formatBlockLabel(label)}`);
      lines.push("");
      lines.push(block.value.trim());
      lines.push("");
    }
  }

  // Add any other blocks
  for (const block of blocks) {
    if (!blockOrder.includes(block.label) && block.value.trim()) {
      lines.push(`## ${formatBlockLabel(block.label)}`);
      lines.push("");
      lines.push(block.value.trim());
      lines.push("");
    }
  }

  // Key memories by type
  const memories = store.list({ limit: 50, minImportance: 0.3 });
  const byType = groupByType(memories);

  for (const [type, typeMemories] of Object.entries(byType)) {
    if (typeMemories.length === 0) continue;

    lines.push(`## ${formatTypeName(type as MemoryEntry["type"])}`);
    lines.push("");

    for (const mem of typeMemories) {
      const confidence = mem.confidence >= 0.8 ? "" : ` (${Math.round(mem.confidence * 100)}%)`;
      lines.push(`- ${mem.content}${confidence}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Write MEMORY.md to disk.
 */
export function writeMemoryFile(markdownPath: string, store: FactsMemoryStore): void {
  const content = generateMemoryMarkdown(store);
  const filePath = join(markdownPath, MEMORY_FILE);

  mkdirSync(markdownPath, { recursive: true, mode: 0o700 });
  writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
}

/**
 * Parse MEMORY.md and import into store.
 * Only imports memory blocks, not individual memories.
 */
export function importMemoryFile(markdownPath: string, store: FactsMemoryStore): ImportResult {
  const filePath = join(markdownPath, MEMORY_FILE);

  if (!existsSync(filePath)) {
    return { success: false, error: "MEMORY.md not found", blocksImported: 0 };
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    const blocks = parseMemoryBlocks(content);

    for (const block of blocks) {
      store.upsertBlock(block);
    }

    return { success: true, blocksImported: blocks.length };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { success: false, error, blocksImported: 0 };
  }
}

/**
 * Parse memory blocks from markdown content.
 */
function parseMemoryBlocks(content: string): MemoryBlock[] {
  const blocks: MemoryBlock[] = [];
  const lines = content.split("\n");

  let currentLabel: MemoryBlockLabel | null = null;
  let currentContent: string[] = [];

  const labelMap: Record<string, MemoryBlockLabel> = {
    persona: "persona",
    "user profile": "user_profile",
    user_profile: "user_profile",
    "active context": "active_context",
    active_context: "active_context",
  };

  for (const line of lines) {
    // Check for heading
    const headingMatch = line.match(/^##\s+(.+)$/);
    if (headingMatch) {
      // Save previous block
      if (currentLabel && currentContent.length > 0) {
        blocks.push({
          label: currentLabel,
          value: currentContent.join("\n").trim(),
        });
      }

      // Start new block
      const heading = headingMatch[1].toLowerCase().trim();
      currentLabel = labelMap[heading] ?? null;
      currentContent = [];
      continue;
    }

    // Skip top-level headings and metadata
    if (line.startsWith("# ") || line.startsWith(">")) {
      continue;
    }

    // Accumulate content
    if (currentLabel !== null) {
      currentContent.push(line);
    }
  }

  // Save last block
  if (currentLabel && currentContent.length > 0) {
    blocks.push({
      label: currentLabel,
      value: currentContent.join("\n").trim(),
    });
  }

  return blocks;
}

// ============================================================================
// Daily Summaries
// ============================================================================

/**
 * Write daily summary to markdown file.
 */
export function writeDailySummary(markdownPath: string, summary: DailySummary): void {
  const dailyDir = join(markdownPath, DAILY_DIR);
  const filePath = join(dailyDir, `${summary.date}.md`);

  mkdirSync(dailyDir, { recursive: true, mode: 0o700 });

  const lines: string[] = [];
  lines.push(`# Daily Summary: ${summary.date}`);
  lines.push("");
  lines.push(summary.summary);

  if (summary.keyDecisions && summary.keyDecisions.length > 0) {
    lines.push("");
    lines.push("## Key Decisions");
    lines.push("");
    for (const decision of summary.keyDecisions) {
      lines.push(`- ${decision}`);
    }
  }

  if (summary.mentionedEntities && summary.mentionedEntities.length > 0) {
    lines.push("");
    lines.push("## Mentioned Entities");
    lines.push("");
    lines.push(summary.mentionedEntities.join(", "));
  }

  if (summary.tokenCount) {
    lines.push("");
    lines.push(`---`);
    lines.push(`Token count: ~${summary.tokenCount}`);
  }

  writeFileSync(filePath, lines.join("\n"), { encoding: "utf-8", mode: 0o600 });
}

/**
 * Read daily summary from markdown file.
 */
export function readDailySummary(markdownPath: string, date: string): DailySummary | null {
  const filePath = join(markdownPath, DAILY_DIR, `${date}.md`);

  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const content = readFileSync(filePath, "utf-8");
    return parseDailySummary(content, date);
  } catch {
    return null;
  }
}

/**
 * Parse daily summary from markdown content.
 */
function parseDailySummary(content: string, date: string): DailySummary {
  const lines = content.split("\n");
  let summary = "";
  const keyDecisions: string[] = [];
  let mentionedEntities: string[] = [];
  let tokenCount: number | undefined;

  let section: "summary" | "decisions" | "entities" | "footer" = "summary";

  for (const line of lines) {
    // Skip title
    if (line.startsWith("# Daily Summary:")) continue;

    // Check for section headings
    if (line === "## Key Decisions") {
      section = "decisions";
      continue;
    }
    if (line === "## Mentioned Entities") {
      section = "entities";
      continue;
    }
    if (line === "---") {
      section = "footer";
      continue;
    }

    // Parse content based on section
    if (section === "summary" && line.trim()) {
      summary += (summary ? "\n" : "") + line;
    } else if (section === "decisions") {
      const match = line.match(/^-\s+(.+)$/);
      if (match) {
        keyDecisions.push(match[1]);
      }
    } else if (section === "entities" && line.trim()) {
      mentionedEntities = line.split(",").map((e) => e.trim());
    } else if (section === "footer") {
      const tokenMatch = line.match(/Token count:\s*~?(\d+)/);
      if (tokenMatch) {
        tokenCount = parseInt(tokenMatch[1], 10);
      }
    }
  }

  return {
    date,
    summary,
    keyDecisions: keyDecisions.length > 0 ? keyDecisions : undefined,
    mentionedEntities: mentionedEntities.length > 0 ? mentionedEntities : undefined,
    tokenCount,
  };
}

// ============================================================================
// Sync Functions
// ============================================================================

/**
 * Sync memory blocks to MEMORY.md (write-through).
 * Call this after block updates.
 */
export function syncBlocksToMarkdown(markdownPath: string, store: FactsMemoryStore): void {
  writeMemoryFile(markdownPath, store);
}

/**
 * Initialize memory file with default blocks if it doesn't exist.
 */
export function initializeMemoryFile(markdownPath: string, store: FactsMemoryStore): void {
  const filePath = join(markdownPath, MEMORY_FILE);

  if (!existsSync(filePath)) {
    // Create default blocks
    const defaultBlocks: MemoryBlock[] = [
      {
        label: "user_profile",
        value: "No user information recorded yet.",
      },
      {
        label: "active_context",
        value: "No active context.",
      },
    ];

    for (const block of defaultBlocks) {
      store.upsertBlock(block);
    }

    writeMemoryFile(markdownPath, store);
  }
}

// ============================================================================
// Helper Functions
// ============================================================================

function formatBlockLabel(label: MemoryBlockLabel | string): string {
  switch (label) {
    case "persona":
      return "Persona";
    case "user_profile":
      return "User Profile";
    case "active_context":
      return "Active Context";
    default:
      return label
        .split("_")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
  }
}

function formatTypeName(type: MemoryEntry["type"]): string {
  switch (type) {
    case "fact":
      return "Facts";
    case "preference":
      return "Preferences";
    case "decision":
      return "Decisions";
    case "event":
      return "Events";
    case "todo":
      return "To-Do Items";
    default:
      return type;
  }
}

function groupByType(memories: MemoryEntry[]): Record<string, MemoryEntry[]> {
  const grouped: Record<string, MemoryEntry[]> = {
    fact: [],
    preference: [],
    decision: [],
    event: [],
    todo: [],
  };

  for (const mem of memories) {
    if (grouped[mem.type]) {
      grouped[mem.type].push(mem);
    }
  }

  return grouped;
}

// ============================================================================
// Types
// ============================================================================

interface ImportResult {
  success: boolean;
  error?: string;
  blocksImported: number;
}
