/**
 * Facts Memory Migration Tool
 *
 * Migrates data from legacy MEMORY.md files to the facts database.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { FactsMemoryStore } from "./store.js";
import type { MemoryType, MemoryBlockLabel } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// ============================================================================
// Types
// ============================================================================

const logger = createSubsystemLogger("facts-migrate");

export interface MigrationResult {
  success: boolean;
  memoriesImported: number;
  blocksImported: number;
  errors: string[];
  skipped: number;
}

export interface ParsedMemoryItem {
  type: MemoryType;
  content: string;
  tags?: string[];
  importance?: number;
}

export interface ParsedMemoryFile {
  blocks: Map<MemoryBlockLabel, string>;
  memories: ParsedMemoryItem[];
}

// ============================================================================
// Parser
// ============================================================================

/**
 * Parse a legacy MEMORY.md file.
 * Expected format:
 *
 * ## User Profile
 * ...content...
 *
 * ## Persona
 * ...content...
 *
 * ## Facts
 * - fact 1
 * - fact 2
 *
 * ## Preferences
 * - preference 1
 */
export function parseMemoryFile(content: string): ParsedMemoryFile {
  const blocks = new Map<MemoryBlockLabel, string>();
  const memories: ParsedMemoryItem[] = [];

  // Split by headers
  const sections = content.split(/^## /m);

  for (const section of sections) {
    if (!section.trim()) continue;

    const lines = section.split("\n");
    const header = lines[0]?.trim().toLowerCase() ?? "";
    const body = lines.slice(1).join("\n").trim();

    // Parse known sections
    if (header === "user profile" || header === "user_profile") {
      blocks.set("user_profile", body);
    } else if (header === "persona") {
      blocks.set("persona", body);
    } else if (header === "active context" || header === "active_context") {
      blocks.set("active_context", body);
    } else if (header === "facts" || header === "known facts") {
      parseListItems(body, "fact", memories);
    } else if (header === "preferences") {
      parseListItems(body, "preference", memories);
    } else if (header === "decisions") {
      parseListItems(body, "decision", memories);
    } else if (header === "events" || header === "history") {
      parseListItems(body, "event", memories);
    } else if (header === "todos" || header === "tasks") {
      parseListItems(body, "todo", memories);
    }
  }

  return { blocks, memories };
}

/**
 * Parse list items from a section body.
 */
function parseListItems(body: string, type: MemoryType, memories: ParsedMemoryItem[]): void {
  const lines = body.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and non-list items
    if (
      !trimmed ||
      (!trimmed.startsWith("-") && !trimmed.startsWith("*") && !trimmed.match(/^\d+\./))
    ) {
      continue;
    }

    // Remove list marker
    const content = trimmed
      .replace(/^[-*]\s*/, "")
      .replace(/^\d+\.\s*/, "")
      .trim();

    if (content.length < 3) continue; // Skip very short items

    // Extract tags if present (e.g., "[tag1, tag2] content")
    const tagMatch = content.match(/^\[([^\]]+)\]\s*(.+)/);
    let tags: string[] | undefined;
    let cleanContent = content;

    if (tagMatch) {
      tags = tagMatch[1].split(",").map((t) => t.trim());
      cleanContent = tagMatch[2];
    }

    memories.push({
      type,
      content: cleanContent,
      tags,
      importance: inferImportance(cleanContent, type),
    });
  }
}

/**
 * Infer importance based on content and type.
 */
function inferImportance(content: string, type: MemoryType): number {
  // Base importance by type
  const baseImportance: Record<MemoryType, number> = {
    fact: 0.6,
    preference: 0.7,
    decision: 0.8,
    event: 0.5,
    todo: 0.6,
  };

  let importance = baseImportance[type];

  // Boost for longer content (more detailed)
  if (content.length > 100) importance += 0.1;

  // Boost for explicit markers
  const lowerContent = content.toLowerCase();
  if (lowerContent.includes("important") || lowerContent.includes("critical")) {
    importance += 0.15;
  }
  if (lowerContent.includes("name is") || lowerContent.includes("called")) {
    importance += 0.1;
  }

  return Math.min(importance, 1.0);
}

// ============================================================================
// Migration Functions
// ============================================================================

/**
 * Migrate a MEMORY.md file to the facts database.
 */
export function migrateMemoryFile(filePath: string, store: FactsMemoryStore): MigrationResult {
  const result: MigrationResult = {
    success: false,
    memoriesImported: 0,
    blocksImported: 0,
    errors: [],
    skipped: 0,
  };

  try {
    if (!existsSync(filePath)) {
      result.errors.push(`File not found: ${filePath}`);
      return result;
    }

    const content = readFileSync(filePath, "utf-8");
    const parsed = parseMemoryFile(content);

    // Import blocks
    for (const [label, value] of parsed.blocks) {
      try {
        store.upsertBlock({ label, value });
        result.blocksImported++;
        logger.debug(`Imported block: ${label}`);
      } catch (err) {
        result.errors.push(`Failed to import block ${label}: ${err}`);
      }
    }

    // Import memories
    for (const item of parsed.memories) {
      try {
        // Check for duplicates (simple content match)
        const existing = store.searchFts(item.content, { limit: 1 });
        if (existing.length > 0 && existing[0].entry.content === item.content) {
          result.skipped++;
          continue;
        }

        store.add({
          type: item.type,
          content: item.content,
          source: "explicit",
          importance: item.importance ?? 0.5,
          tags: item.tags,
        });
        result.memoriesImported++;
      } catch (err) {
        result.errors.push(`Failed to import memory: ${err}`);
      }
    }

    result.success = result.errors.length === 0;
    logger.info(
      `Migration complete: ${result.memoriesImported} memories, ${result.blocksImported} blocks, ${result.skipped} skipped`,
    );
  } catch (err) {
    result.errors.push(`Migration failed: ${err}`);
    logger.error(`Migration failed: ${err}`);
  }

  return result;
}

/**
 * Migrate all MEMORY.md files from a directory.
 */
export function migrateMemoryDirectory(dirPath: string, store: FactsMemoryStore): MigrationResult {
  const result: MigrationResult = {
    success: false,
    memoriesImported: 0,
    blocksImported: 0,
    errors: [],
    skipped: 0,
  };

  // Common memory file names
  const fileNames = ["MEMORY.md", "memory.md", "MEMORIES.md", "memories.md"];

  for (const fileName of fileNames) {
    const filePath = join(dirPath, fileName);
    if (existsSync(filePath)) {
      const fileResult = migrateMemoryFile(filePath, store);
      result.memoriesImported += fileResult.memoriesImported;
      result.blocksImported += fileResult.blocksImported;
      result.skipped += fileResult.skipped;
      result.errors.push(...fileResult.errors);
    }
  }

  result.success =
    result.errors.length === 0 && (result.memoriesImported > 0 || result.blocksImported > 0);
  return result;
}

/**
 * Export current database to MEMORY.md format.
 */
export function exportToMemoryFile(store: FactsMemoryStore): string {
  const parts: string[] = [];

  // Export blocks
  const blocks = store.getAllBlocks();
  for (const block of blocks) {
    const label = formatBlockLabel(block.label);
    parts.push(`## ${label}\n\n${block.value}`);
  }

  // Export memories by type
  const memories = store.list({ includeSuperseded: false });
  const byType = new Map<MemoryType, string[]>();

  for (const mem of memories) {
    const list = byType.get(mem.type) ?? [];
    const tags = mem.tags?.length ? `[${mem.tags.join(", ")}] ` : "";
    list.push(`- ${tags}${mem.content}`);
    byType.set(mem.type, list);
  }

  if (byType.has("fact")) {
    parts.push(`## Facts\n\n${byType.get("fact")!.join("\n")}`);
  }
  if (byType.has("preference")) {
    parts.push(`## Preferences\n\n${byType.get("preference")!.join("\n")}`);
  }
  if (byType.has("decision")) {
    parts.push(`## Decisions\n\n${byType.get("decision")!.join("\n")}`);
  }
  if (byType.has("event")) {
    parts.push(`## Events\n\n${byType.get("event")!.join("\n")}`);
  }
  if (byType.has("todo")) {
    parts.push(`## Todos\n\n${byType.get("todo")!.join("\n")}`);
  }

  return parts.join("\n\n");
}

function formatBlockLabel(label: MemoryBlockLabel): string {
  switch (label) {
    case "user_profile":
      return "User Profile";
    case "persona":
      return "Persona";
    case "active_context":
      return "Active Context";
    default:
      return label;
  }
}
