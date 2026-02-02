/**
 * Facts Memory Integration
 *
 * Integrates the facts memory system with the reply pipeline.
 * Provides singleton access to the memory manager and LLM call bridge.
 */

import type { Api, AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { complete } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import type { FactsMemoryConfig } from "../../config/types.openclaw.js";
import type { LlmCallFn } from "./extractor.js";
import type { RetrievalTrace } from "./types.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { ensureOpenClawModelsJson } from "../../agents/models-config.js";
import { discoverAuthStorage, discoverModels } from "../../agents/pi-model-discovery.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { runConsolidation, type ConsolidationResult } from "./consolidation.js";
import {
  createFactsMemoryManager,
  type FactsMemoryManager,
  resetFactsMemoryManager,
} from "./manager.js";
import { getRelevantContext, getRelevantContextWithTrace } from "./retrieval.js";

// ============================================================================
// Singleton Manager
// ============================================================================

const logger = createSubsystemLogger("facts-memory-integration");
let managerInstance: FactsMemoryManager | null = null;
let currentConfig: FactsMemoryConfig | null = null;

/**
 * Get or create the facts memory manager singleton.
 * Uses config from OpenClawConfig if available.
 */
export function getFactsMemoryManagerInstance(cfg?: OpenClawConfig): FactsMemoryManager | null {
  const factsConfig = cfg?.factsMemory;

  // If facts memory is explicitly disabled, return null
  if (factsConfig?.enabled === false) {
    return null;
  }

  // If already initialized with same config, return existing instance
  if (managerInstance && currentConfig === factsConfig) {
    return managerInstance;
  }

  // Create new manager with config
  try {
    if (managerInstance) {
      resetFactsMemoryManager();
    }

    managerInstance = createFactsMemoryManager(factsConfig ?? {});
    currentConfig = factsConfig ?? null;

    // Set up LLM call if configured
    const llmCall = createLlmCallBridge(cfg);
    if (llmCall) {
      managerInstance.setLlmCall(llmCall);
      logger.debug("LLM call function configured for facts memory");
    }

    logger.debug("Facts memory manager initialized");
    return managerInstance;
  } catch (err) {
    logger.error(`Failed to initialize facts memory manager: ${err}`);
    return null;
  }
}

/**
 * Reset the facts memory manager singleton.
 */
export function resetFactsMemoryManagerInstance(): void {
  if (managerInstance) {
    resetFactsMemoryManager();
    managerInstance = null;
    currentConfig = null;
    logger.debug("Facts memory manager reset");
  }
}

// ============================================================================
// Session Context Retrieval
// ============================================================================

/**
 * Get session context for prompt injection.
 * Returns empty string if facts memory is not enabled.
 */
export async function getFactsSessionContext(cfg?: OpenClawConfig): Promise<string> {
  const manager = getFactsMemoryManagerInstance(cfg);
  if (!manager) {
    return "";
  }

  try {
    return await manager.getSessionContext();
  } catch (err) {
    logger.warn(`Failed to get session context: ${err}`);
    return "";
  }
}

/**
 * Get relevant context for a specific message (query-time retrieval).
 * Returns empty string if facts memory is not enabled.
 * Applies access control filtering when factsMemory.access.enabled=true.
 *
 * @param message - Query message
 * @param cfg - OpenClaw config (optional)
 * @param options - Options including role override
 */
export function getFactsRelevantContext(
  message: string,
  cfg?: OpenClawConfig,
  options?: {
    role?: "admin" | "operator" | "analyst" | "guest";
  },
): string {
  const manager = getFactsMemoryManagerInstance(cfg);
  if (!manager) {
    return "";
  }

  try {
    // Build access options from config
    const accessConfig = cfg?.factsMemory?.access;
    const accessEnabled = accessConfig?.enabled ?? false;
    const accessRole = options?.role ?? accessConfig?.defaultRole ?? "operator";

    // Get custom allowed types from role config if defined
    const roleConfig = accessConfig?.roles?.[accessRole];
    const allowedTypes = roleConfig?.allowedTypes;

    return getRelevantContext(manager.getStore(), message, {
      access: accessEnabled
        ? {
            enabled: true,
            role: accessRole,
            allowedTypes,
          }
        : undefined,
    });
  } catch (err) {
    logger.warn(`Failed to get relevant context: ${err}`);
    return "";
  }
}

/**
 * Get relevant context with full trace information (explainability).
 * Returns both the context string and detailed reasons for each memory included.
 * Returns null if facts memory is not enabled.
 *
 * @param message - Query message
 * @param cfg - OpenClaw config (optional)
 * @param options - Retrieval options
 * @param options.role - Override the default role from config (for admin override)
 */
export function getFactsRelevantContextWithTrace(
  message: string,
  cfg?: OpenClawConfig,
  options?: {
    maxResults?: number;
    minScore?: number;
    maxTokens?: number;
    role?: "admin" | "operator" | "analyst" | "guest";
  },
): RetrievalTrace | null {
  const manager = getFactsMemoryManagerInstance(cfg);
  if (!manager) {
    return null;
  }

  try {
    // Build access options from config
    const accessConfig = cfg?.factsMemory?.access;
    const accessEnabled = accessConfig?.enabled ?? false;
    const accessRole = options?.role ?? accessConfig?.defaultRole ?? "operator";

    // Get custom allowed types from role config if defined
    const roleConfig = accessConfig?.roles?.[accessRole];
    const allowedTypes = roleConfig?.allowedTypes;

    return getRelevantContextWithTrace(manager.getStore(), message, {
      maxResults: options?.maxResults,
      minScore: options?.minScore,
      maxTokens: options?.maxTokens,
      access: accessEnabled
        ? {
            enabled: true,
            role: accessRole,
            allowedTypes,
          }
        : undefined,
    });
  } catch (err) {
    logger.warn(`Failed to get relevant context with trace: ${err}`);
    return null;
  }
}

// ============================================================================
// Message Collection for Extraction
// ============================================================================

/** Buffer for collecting messages for batch extraction */
const messageBuffer: Map<string, string[]> = new Map();
const DEFAULT_BATCH_SIZE = 10;

/**
 * Add a user message to the extraction buffer.
 * When buffer reaches batch size, triggers extraction.
 */
export function addMessageForExtraction(
  sessionKey: string,
  message: string,
  cfg?: OpenClawConfig,
): void {
  const factsConfig = cfg?.factsMemory;

  // Skip if extraction is disabled
  if (factsConfig?.enabled === false || factsConfig?.extraction?.enabled === false) {
    return;
  }

  // Get or create buffer for this session
  let buffer = messageBuffer.get(sessionKey);
  if (!buffer) {
    buffer = [];
    messageBuffer.set(sessionKey, buffer);
  }

  // Add message to buffer
  buffer.push(message);

  // Check if we should trigger extraction based on batch size
  const batchSize = factsConfig?.batchSize ?? DEFAULT_BATCH_SIZE;
  if (buffer.length >= batchSize) {
    // Trigger extraction asynchronously (don't block the reply)
    triggerExtraction(sessionKey, cfg).catch((err) => {
      logger.warn(`Background extraction failed: ${err}`);
    });
  }
}

/**
 * Flush pending messages for a session after reply is complete.
 * This ensures short sessions don't lose memories.
 */
export function flushSessionMessages(sessionKey: string, cfg?: OpenClawConfig): void {
  const buffer = messageBuffer.get(sessionKey);
  if (!buffer || buffer.length === 0) {
    return;
  }

  // Trigger extraction asynchronously
  triggerExtraction(sessionKey, cfg).catch((err) => {
    logger.warn(`Post-reply extraction failed: ${err}`);
  });
}

/**
 * Trigger extraction for a session's buffered messages.
 */
export async function triggerExtraction(sessionKey: string, cfg?: OpenClawConfig): Promise<void> {
  const manager = getFactsMemoryManagerInstance(cfg);
  if (!manager) {
    return;
  }

  const buffer = messageBuffer.get(sessionKey);
  if (!buffer || buffer.length === 0) {
    return;
  }

  // Clear buffer before extraction (to avoid double processing)
  const messages = [...buffer];
  messageBuffer.set(sessionKey, []);

  try {
    const extracted = await manager.extractFromBatch(messages, sessionKey);
    if (extracted.length > 0) {
      logger.info(`Extracted ${extracted.length} memories from session ${sessionKey}`);
    }
  } catch (err) {
    logger.error(`Extraction failed for session ${sessionKey}: ${err}`);
    // Don't re-add messages on failure - they're already processed or lost
  }
}

/**
 * Flush all pending extractions (e.g., on shutdown).
 */
export async function flushAllExtractions(cfg?: OpenClawConfig): Promise<void> {
  const sessions = Array.from(messageBuffer.keys());
  await Promise.all(sessions.map((sessionKey) => triggerExtraction(sessionKey, cfg)));
}

// ============================================================================
// Consolidation
// ============================================================================

/**
 * Run memory consolidation (daily/weekly summaries + pruning).
 * Can be triggered via cron job or manual call.
 */
export async function runMemoryConsolidation(
  cfg?: OpenClawConfig,
): Promise<ConsolidationResult | null> {
  const manager = getFactsMemoryManagerInstance(cfg);
  if (!manager) {
    logger.debug("Facts memory not enabled, skipping consolidation");
    return null;
  }

  const factsConfig = cfg?.factsMemory;
  const markdownPath = factsConfig?.markdownPath;

  try {
    const llmCall = createLlmCallBridge(cfg);
    const result = await runConsolidation(manager.getStore(), llmCall, markdownPath);
    logger.info(
      `Consolidation complete: daily=${result.dailySummary ? "yes" : "no"}, weekly=${result.weeklySummary ? "yes" : "no"}, pruned=${result.pruned.deleted + result.pruned.expired}`,
    );
    return result;
  } catch (err) {
    logger.error(`Consolidation failed: ${err}`);
    return null;
  }
}

// ============================================================================
// LLM Call Bridge
// ============================================================================

/**
 * Create an LLM call function that uses the OpenClaw infrastructure.
 * Uses the configured provider/model from factsMemory.extraction.
 */
export function createLlmCallBridge(cfg?: OpenClawConfig, agentDir?: string): LlmCallFn | null {
  const factsConfig = cfg?.factsMemory;
  const provider = factsConfig?.extraction?.provider;
  const model = factsConfig?.extraction?.model;

  if (!provider || !model) {
    // No explicit extraction model configured - extraction will be disabled
    logger.debug("No extraction provider/model configured, LLM extraction disabled");
    return null;
  }

  const resolvedAgentDir = agentDir ?? resolveOpenClawAgentDir();

  // Return an async function that performs the LLM call
  return async (systemPrompt: string, userPrompt: string): Promise<string> => {
    try {
      // Ensure models.json exists
      await ensureOpenClawModelsJson(cfg, resolvedAgentDir);

      // Discover auth and models
      const authStorage = discoverAuthStorage(resolvedAgentDir);
      const modelRegistry = discoverModels(authStorage, resolvedAgentDir);

      // Find the model
      const modelDef = modelRegistry.find(provider, model) as Model<Api> | null;
      if (!modelDef) {
        throw new Error(`Unknown model: ${provider}/${model}`);
      }

      // Get API key
      const apiKeyInfo = await getApiKeyForModel({
        model: modelDef,
        cfg,
        agentDir: resolvedAgentDir,
      });
      const apiKey = requireApiKey(apiKeyInfo, modelDef.provider);
      authStorage.setRuntimeApiKey(modelDef.provider, apiKey);

      // Build context with combined system + user prompt
      // (pi-ai doesn't have a separate system role, so we embed it in user message)
      const combinedPrompt = `${systemPrompt}\n\n---\n\n${userPrompt}`;
      const context: Context = {
        messages: [
          {
            role: "user",
            content: combinedPrompt,
            timestamp: Date.now(),
          },
        ],
      };

      // Call the model
      const message = (await complete(modelDef, context, {
        apiKey,
        maxTokens: 1024,
      })) as AssistantMessage;

      // Extract text from response
      if (typeof message.content === "string") {
        return message.content;
      }

      if (Array.isArray(message.content)) {
        const textParts = message.content
          .filter(
            (part): part is { type: "text"; text: string } =>
              typeof part === "object" &&
              part !== null &&
              part.type === "text" &&
              typeof part.text === "string",
          )
          .map((part) => part.text);
        return textParts.join("");
      }

      return "";
    } catch (err) {
      logger.error(`LLM call failed: ${err}`);
      throw err;
    }
  };
}

/**
 * Set up the LLM call function for the facts memory manager.
 */
export function setupLlmCallForManager(cfg?: OpenClawConfig, agentDir?: string): void {
  const manager = getFactsMemoryManagerInstance(cfg);
  if (!manager) {
    return;
  }

  const llmCall = createLlmCallBridge(cfg, agentDir);
  if (llmCall) {
    manager.setLlmCall(llmCall);
    logger.debug("LLM call function set for facts memory manager");
  }
}
