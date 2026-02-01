/**
 * Facts Memory Extractor
 *
 * LLM-based batch extraction of memories from conversations.
 * Uses the 4-operation model: ADD, UPDATE, DELETE, NONE.
 */

import type {
  BatchExtractionInput,
  BatchExtractionOutput,
  ExtractionResult,
  MemoryBlock,
  MemoryEntry,
} from "./types.js";
import { filterMessagesForExtraction } from "./classifier.js";

// ============================================================================
// Extraction Prompt
// ============================================================================

const EXTRACTION_SYSTEM_PROMPT = `You are a memory extraction assistant. Your job is to identify important information from conversations that should be remembered.

Extract information using these operations:
- ADD: Create a new memory (facts, preferences, decisions, events, todos)
- UPDATE: Modify an existing memory (provide target ID)
- DELETE: Remove an existing memory (provide target ID)
- NONE: No action needed

Memory types:
- fact: Personal information, contact details, background info
- preference: User likes, dislikes, preferred ways of working
- decision: Choices made, agreed approaches, selected options
- event: Scheduled activities, meetings, deadlines
- todo: Tasks to be done, reminders, action items

Rules:
1. Only extract genuinely important, reusable information
2. Ignore greetings, small talk, and transient discussion
3. For explicit "remember" requests, always extract
4. Use high confidence (0.9+) for explicit requests
5. Use lower confidence (0.6-0.8) for inferred information
6. If an existing memory contradicts new information, use UPDATE
7. Output ONLY valid JSON array, no explanation

Output format (JSON array):
[
  {"op": "ADD", "type": "fact", "content": "User's name is John", "confidence": 0.95, "tags": ["identity"]},
  {"op": "UPDATE", "target": "mem-123", "content": "Updated preference text", "confidence": 0.8},
  {"op": "DELETE", "target": "mem-456"}
]

If nothing should be extracted, output: []`;

function buildExtractionPrompt(input: BatchExtractionInput): string {
  let prompt = "Conversation to analyze:\n";
  for (const message of input.messages) {
    prompt += `\n---\n${message}`;
  }

  if (input.existingMemories && input.existingMemories.length > 0) {
    prompt += "\n\n---\n\nExisting memories for context (use UPDATE/DELETE if needed):\n";
    for (const mem of input.existingMemories.slice(0, 20)) {
      prompt += `\n- [${mem.id}] (${mem.type}): ${mem.content}`;
    }
  }

  if (input.currentBlocks && input.currentBlocks.length > 0) {
    prompt += "\n\n---\n\nCurrent memory blocks:\n";
    for (const block of input.currentBlocks) {
      prompt += `\n## ${block.label}\n${block.value}\n`;
    }
  }

  prompt += "\n\n---\n\nExtract memories (JSON array only):";

  return prompt;
}

// ============================================================================
// Extraction Functions
// ============================================================================

/**
 * Extract memories from a batch of messages using LLM.
 */
export async function extractFromBatch(
  input: BatchExtractionInput,
  llmCall: LlmCallFn,
): Promise<BatchExtractionOutput> {
  // Filter messages using classifier
  const { filtered } = filterMessagesForExtraction(input.messages);

  // If no messages pass the filter, return empty
  if (filtered.length === 0) {
    return {
      results: [],
      success: true,
    };
  }

  // Build prompt
  const prompt = buildExtractionPrompt({
    ...input,
    messages: filtered,
  });

  try {
    // Call LLM
    const response = await llmCall(EXTRACTION_SYSTEM_PROMPT, prompt);

    // Parse response
    const results = parseExtractionResponse(response);

    return {
      results,
      rawResponse: response,
      success: true,
    };
  } catch (err) {
    // Retry once on error
    try {
      const response = await llmCall(EXTRACTION_SYSTEM_PROMPT, prompt);
      const results = parseExtractionResponse(response);

      return {
        results,
        rawResponse: response,
        success: true,
      };
    } catch (retryErr) {
      const error = retryErr instanceof Error ? retryErr.message : String(retryErr);
      return {
        results: [],
        success: false,
        error: `Extraction failed after retry: ${error}`,
      };
    }
  }
}

/**
 * Parse the LLM response into ExtractionResult array.
 */
function parseExtractionResponse(response: string): ExtractionResult[] {
  // Clean response - extract JSON array
  const trimmed = response.trim();

  // Try to find JSON array in response
  let jsonStr = trimmed;

  // Handle markdown code blocks
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  // Handle array that might be embedded in text
  const arrayMatch = jsonStr.match(/\[[\s\S]*\]/);
  if (arrayMatch) {
    jsonStr = arrayMatch[0];
  }

  // Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Try to fix common JSON issues
    const fixed = jsonStr
      .replace(/'/g, '"') // Single quotes to double
      .replace(/,\s*}/g, "}") // Trailing commas
      .replace(/,\s*]/g, "]");

    parsed = JSON.parse(fixed);
  }

  // Validate and normalize results
  if (!Array.isArray(parsed)) {
    return [];
  }

  const results: ExtractionResult[] = [];

  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;

    const result: ExtractionResult = {
      op: validateOp((item as Record<string, unknown>).op),
    };

    if (result.op === "ADD") {
      const type = (item as Record<string, unknown>).type;
      if (isValidType(type)) {
        result.type = type;
      } else {
        result.type = "fact"; // Default type
      }
      result.content = String((item as Record<string, unknown>).content ?? "");
      result.confidence = Number((item as Record<string, unknown>).confidence ?? 0.8);
      const tags = (item as Record<string, unknown>).tags;
      if (Array.isArray(tags)) {
        result.tags = tags.filter((t): t is string => typeof t === "string");
      }
    } else if (result.op === "UPDATE") {
      result.target = String((item as Record<string, unknown>).target ?? "");
      result.content = String((item as Record<string, unknown>).content ?? "");
      result.confidence = Number((item as Record<string, unknown>).confidence ?? 0.8);
    } else if (result.op === "DELETE") {
      result.target = String((item as Record<string, unknown>).target ?? "");
    }

    // Skip invalid entries
    if (result.op === "NONE") continue;
    if (result.op === "ADD" && !result.content) continue;
    if ((result.op === "UPDATE" || result.op === "DELETE") && !result.target) continue;

    results.push(result);
  }

  return results;
}

function validateOp(op: unknown): ExtractionResult["op"] {
  if (op === "ADD" || op === "UPDATE" || op === "DELETE" || op === "NONE") {
    return op;
  }
  return "NONE";
}

function isValidType(type: unknown): type is ExtractionResult["type"] {
  return (
    type === "fact" ||
    type === "preference" ||
    type === "decision" ||
    type === "event" ||
    type === "todo"
  );
}

// ============================================================================
// Block Update Extraction
// ============================================================================

const BLOCK_UPDATE_PROMPT = `You are a memory block updater. Based on the extracted memories, update the relevant memory blocks.

Memory blocks:
- persona: AI assistant personality and behavior guidelines
- user_profile: Information about the user (name, preferences, background)
- active_context: Current project context, recent decisions, active tasks

For each block that needs updating, output the complete new content.
Output format (JSON object):
{
  "user_profile": "Updated content...",
  "active_context": "Updated content..."
}

Only include blocks that need changes. Output {} if no updates needed.`;

/**
 * Extract block updates from extraction results.
 */
export async function extractBlockUpdates(
  results: ExtractionResult[],
  currentBlocks: MemoryBlock[],
  llmCall: LlmCallFn,
): Promise<Partial<Record<string, string>>> {
  // Filter for relevant results
  const relevantResults = results.filter(
    (r) =>
      r.op === "ADD" && (r.type === "fact" || r.type === "preference" || r.type === "decision"),
  );

  if (relevantResults.length === 0) {
    return {};
  }

  const prompt = `New memories to incorporate:
${relevantResults.map((r) => `- [${r.type}]: ${r.content}`).join("\n")}

Current blocks:
${currentBlocks.map((b) => `## ${b.label}\n${b.value}`).join("\n\n")}

Update blocks as needed (JSON):`;

  try {
    const response = await llmCall(BLOCK_UPDATE_PROMPT, prompt);

    // Parse response
    const trimmed = response.trim();
    let jsonStr = trimmed;

    const codeBlockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1].trim();
    }

    const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
    if (objectMatch) {
      jsonStr = objectMatch[0];
    }

    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const updates: Partial<Record<string, string>> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.trim()) {
        updates[key] = value;
      }
    }

    return updates;
  } catch {
    return {};
  }
}

// ============================================================================
// Types
// ============================================================================

/** LLM call function signature */
export type LlmCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

/**
 * Create a stub LLM call function for testing.
 */
export function createStubLlmCall(): LlmCallFn {
  return async (_system: string, _user: string): Promise<string> => {
    return "[]";
  };
}
