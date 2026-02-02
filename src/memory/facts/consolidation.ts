/**
 * Facts Memory Consolidation
 *
 * Handles daily/weekly summaries and pruning of low-importance/expired memories.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import type { LlmCallFn } from "./extractor.js";
import type { FactsMemoryStore } from "./store.js";
import type { DailySummary, MemoryEntry } from "./types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";

// ============================================================================
// Constants
// ============================================================================

const logger = createSubsystemLogger("facts-consolidation");

/** Minimum importance for memories to survive pruning */
const PRUNE_IMPORTANCE_THRESHOLD = 0.2;
/** Maximum age in days for low-importance memories */
const MAX_LOW_IMPORTANCE_AGE_DAYS = 30;

// ============================================================================
// Daily Summary
// ============================================================================

/**
 * Generate a daily summary for the specified date.
 * Should be called at end of day (e.g., 23:55).
 */
export async function generateDailySummary(
  store: FactsMemoryStore,
  date: string,
  llmCall: LlmCallFn | null,
  markdownPath?: string,
): Promise<DailySummary | null> {
  const startOfDay = getStartOfDay(date);
  const endOfDay = startOfDay + 86400; // +24 hours

  // Get memories created today
  const todaysMemories = store.list({ includeSuperseded: false }).filter((m) => {
    return m.createdAt >= startOfDay && m.createdAt < endOfDay;
  });

  if (todaysMemories.length === 0) {
    logger.debug(`No memories to summarize for ${date}`);
    return null;
  }

  // Generate summary
  let summary: string;
  let keyDecisions: string[] = [];
  let mentionedEntities: string[] = [];

  if (llmCall) {
    // Use LLM to generate summary
    const result = await generateSummaryWithLlm(todaysMemories, llmCall);
    summary = result.summary;
    keyDecisions = result.keyDecisions;
    mentionedEntities = result.mentionedEntities;
  } else {
    // Fallback: simple concatenation
    summary = generateSimpleSummary(todaysMemories);
    keyDecisions = todaysMemories.filter((m) => m.type === "decision").map((m) => m.content);
  }

  const dailySummary: DailySummary = {
    date,
    summary,
    keyDecisions: keyDecisions.length > 0 ? keyDecisions : undefined,
    mentionedEntities: mentionedEntities.length > 0 ? mentionedEntities : undefined,
    tokenCount: Math.ceil(summary.length / 4),
  };

  // Save to database
  store.saveDailySummary(dailySummary);
  logger.info(`Generated daily summary for ${date} (${todaysMemories.length} memories)`);

  // Write markdown file
  if (markdownPath) {
    writeDailySummaryMarkdown(markdownPath, dailySummary);
  }

  return dailySummary;
}

/**
 * Generate summary using LLM.
 */
async function generateSummaryWithLlm(
  memories: MemoryEntry[],
  llmCall: LlmCallFn,
): Promise<{ summary: string; keyDecisions: string[]; mentionedEntities: string[] }> {
  const systemPrompt = `You are a memory consolidation assistant. Summarize the following memories from today's conversations into a brief, coherent narrative. Extract key decisions and important entities mentioned.

Output format (JSON):
{
  "summary": "Brief narrative summary (2-4 sentences)",
  "keyDecisions": ["decision 1", "decision 2"],
  "mentionedEntities": ["entity 1", "entity 2"]
}`;

  const memoriesList = memories.map((m) => `- [${m.type}] ${m.content}`).join("\n");
  const userPrompt = `Today's memories:\n${memoriesList}`;

  try {
    const response = await llmCall(systemPrompt, userPrompt);
    const parsed = JSON.parse(response);
    return {
      summary: parsed.summary ?? generateSimpleSummary(memories),
      keyDecisions: parsed.keyDecisions ?? [],
      mentionedEntities: parsed.mentionedEntities ?? [],
    };
  } catch (err) {
    logger.warn(`LLM summary generation failed: ${err}`);
    return {
      summary: generateSimpleSummary(memories),
      keyDecisions: memories.filter((m) => m.type === "decision").map((m) => m.content),
      mentionedEntities: [],
    };
  }
}

/**
 * Generate simple summary without LLM.
 */
function generateSimpleSummary(memories: MemoryEntry[]): string {
  const byType = new Map<string, number>();
  for (const m of memories) {
    byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
  }

  const parts: string[] = [];
  if (byType.has("fact")) parts.push(`${byType.get("fact")} facts learned`);
  if (byType.has("preference")) parts.push(`${byType.get("preference")} preferences noted`);
  if (byType.has("decision")) parts.push(`${byType.get("decision")} decisions made`);
  if (byType.has("event")) parts.push(`${byType.get("event")} events recorded`);
  if (byType.has("todo")) parts.push(`${byType.get("todo")} todos added`);

  return parts.length > 0 ? `Today: ${parts.join(", ")}.` : "No significant activity.";
}

/**
 * Write daily summary to markdown file.
 */
function writeDailySummaryMarkdown(basePath: string, summary: DailySummary): void {
  const dailyDir = join(basePath, "daily");
  mkdirSync(dailyDir, { recursive: true });

  const filePath = join(dailyDir, `${summary.date}.md`);
  const content = `# Daily Summary: ${summary.date}

${summary.summary}

${summary.keyDecisions && summary.keyDecisions.length > 0 ? `## Key Decisions\n${summary.keyDecisions.map((d) => `- ${d}`).join("\n")}\n\n` : ""}${summary.mentionedEntities && summary.mentionedEntities.length > 0 ? `## Mentioned Entities\n${summary.mentionedEntities.map((e) => `- ${e}`).join("\n")}\n` : ""}`;

  writeFileSync(filePath, content, "utf-8");
  logger.debug(`Wrote daily summary to ${filePath}`);
}

// ============================================================================
// Weekly Summary
// ============================================================================

/**
 * Generate a weekly summary for the week containing the specified date.
 * Should be called at start of week (e.g., Sunday 03:00).
 */
export async function generateWeeklySummary(
  store: FactsMemoryStore,
  date: string,
  llmCall: LlmCallFn | null,
  markdownPath?: string,
): Promise<{ weekId: string; summary: string } | null> {
  const { weekId, startDate, endDate } = getWeekBounds(date);

  // Get daily summaries for the week
  const dailySummaries: DailySummary[] = [];
  const current = new Date(startDate);
  const end = new Date(endDate);

  while (current < end) {
    const dateStr = formatDateString(current);
    const summary = store.getDailySummary(dateStr);
    if (summary) {
      dailySummaries.push(summary);
    }
    current.setDate(current.getDate() + 1);
  }

  if (dailySummaries.length === 0) {
    logger.debug(`No daily summaries for week ${weekId}`);
    return null;
  }

  // Generate weekly summary
  let weeklySummary: string;

  if (llmCall) {
    weeklySummary = await generateWeeklySummaryWithLlm(dailySummaries, llmCall);
  } else {
    weeklySummary = generateSimpleWeeklySummary(dailySummaries);
  }

  logger.info(`Generated weekly summary for ${weekId} (${dailySummaries.length} days)`);

  // Write markdown file
  if (markdownPath) {
    writeWeeklySummaryMarkdown(markdownPath, weekId, weeklySummary, dailySummaries);
  }

  return { weekId, summary: weeklySummary };
}

/**
 * Generate weekly summary using LLM.
 */
async function generateWeeklySummaryWithLlm(
  dailySummaries: DailySummary[],
  llmCall: LlmCallFn,
): Promise<string> {
  const systemPrompt = `You are a memory consolidation assistant. Create a brief weekly summary from the following daily summaries. Focus on recurring themes, important decisions, and progress made.

Output: A single paragraph (3-5 sentences) summarizing the week.`;

  const summariesList = dailySummaries.map((s) => `${s.date}: ${s.summary}`).join("\n");
  const userPrompt = `Daily summaries:\n${summariesList}`;

  try {
    return await llmCall(systemPrompt, userPrompt);
  } catch (err) {
    logger.warn(`LLM weekly summary failed: ${err}`);
    return generateSimpleWeeklySummary(dailySummaries);
  }
}

/**
 * Generate simple weekly summary without LLM.
 */
function generateSimpleWeeklySummary(dailySummaries: DailySummary[]): string {
  const allDecisions = dailySummaries.flatMap((s) => s.keyDecisions ?? []);
  const uniqueDecisions = [...new Set(allDecisions)];

  return `Week summary: ${dailySummaries.length} active days. ${uniqueDecisions.length > 0 ? `Key decisions: ${uniqueDecisions.slice(0, 3).join("; ")}.` : ""}`;
}

/**
 * Write weekly summary to markdown file.
 */
function writeWeeklySummaryMarkdown(
  basePath: string,
  weekId: string,
  summary: string,
  dailySummaries: DailySummary[],
): void {
  const weeklyDir = join(basePath, "weekly");
  mkdirSync(weeklyDir, { recursive: true });

  const filePath = join(weeklyDir, `${weekId}.md`);
  const content = `# Weekly Summary: ${weekId}

${summary}

## Daily Summaries

${dailySummaries.map((s) => `### ${s.date}\n${s.summary}`).join("\n\n")}
`;

  writeFileSync(filePath, content, "utf-8");
  logger.debug(`Wrote weekly summary to ${filePath}`);
}

// ============================================================================
// Pruning
// ============================================================================

/**
 * Prune low-importance and expired memories.
 * Should be called periodically (e.g., daily).
 */
export function pruneMemories(store: FactsMemoryStore): { deleted: number; expired: number } {
  const now = Math.floor(Date.now() / 1000);
  const memories = store.list({ includeSuperseded: false });
  let deleted = 0;
  let expired = 0;

  for (const memory of memories) {
    // Check if expired
    if (memory.expiresAt && memory.expiresAt <= now) {
      store.delete(memory.id);
      expired++;
      continue;
    }

    // Check if low-importance and old
    if (memory.importance < PRUNE_IMPORTANCE_THRESHOLD) {
      const ageInDays = (now - memory.createdAt) / 86400;
      if (ageInDays > MAX_LOW_IMPORTANCE_AGE_DAYS && memory.accessCount === 0) {
        store.delete(memory.id);
        deleted++;
      }
    }
  }

  if (deleted > 0 || expired > 0) {
    logger.info(`Pruned memories: ${deleted} low-importance, ${expired} expired`);
  }

  return { deleted, expired };
}

// ============================================================================
// Scheduled Consolidation
// ============================================================================

export interface ConsolidationResult {
  dailySummary: DailySummary | null;
  weeklySummary: { weekId: string; summary: string } | null;
  pruned: { deleted: number; expired: number };
}

/**
 * Run full consolidation (daily summary, weekly summary if Sunday, pruning).
 * Should be called at end of day (e.g., 23:55).
 */
export async function runConsolidation(
  store: FactsMemoryStore,
  llmCall: LlmCallFn | null,
  markdownPath?: string,
): Promise<ConsolidationResult> {
  const today = new Date();
  const dateStr = formatDateString(today);
  const isSunday = today.getDay() === 0;

  // Generate daily summary
  const dailySummary = await generateDailySummary(store, dateStr, llmCall, markdownPath);

  // Generate weekly summary on Sunday
  let weeklySummary: { weekId: string; summary: string } | null = null;
  if (isSunday) {
    weeklySummary = await generateWeeklySummary(store, dateStr, llmCall, markdownPath);
  }

  // Prune memories
  const pruned = pruneMemories(store);

  return { dailySummary, weeklySummary, pruned };
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get Unix timestamp for start of day (00:00:00 UTC).
 */
function getStartOfDay(dateStr: string): number {
  const date = new Date(dateStr + "T00:00:00Z");
  return Math.floor(date.getTime() / 1000);
}

/**
 * Get ISO week ID and date bounds for a date.
 */
function getWeekBounds(dateStr: string): { weekId: string; startDate: string; endDate: string } {
  const date = new Date(dateStr);
  const year = date.getFullYear();

  // Get ISO week number
  const jan1 = new Date(year, 0, 1);
  const dayOfYear = Math.floor((date.getTime() - jan1.getTime()) / 86400000) + 1;
  const weekNum = Math.ceil((dayOfYear + jan1.getDay()) / 7);

  // Calculate week bounds (Monday to Sunday)
  const dayOfWeek = date.getDay() || 7; // Convert Sunday from 0 to 7
  const monday = new Date(date);
  monday.setDate(date.getDate() - dayOfWeek + 1);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 7);

  return {
    weekId: `${year}-W${String(weekNum).padStart(2, "0")}`,
    startDate: formatDateString(monday),
    endDate: formatDateString(sunday),
  };
}

/**
 * Format date as YYYY-MM-DD.
 */
function formatDateString(date: Date): string {
  return date.toISOString().split("T")[0];
}
