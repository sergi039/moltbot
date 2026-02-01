/**
 * Memory HTTP API Endpoints
 *
 * Provides REST endpoints for facts memory status and top facts retrieval.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  sendJson,
  sendMethodNotAllowed,
  sendInvalidRequest,
  sendUnauthorized,
} from "./http-common.js";
import { loadConfig } from "../config/config.js";
import {
  createFactsMemoryManager,
  getHealthSummary,
  getTopFacts,
  getRelevantContextWithTrace,
  type FactsMemoryManager,
} from "../memory/facts/index.js";
import { authorizeGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import { getBearerToken } from "./http-utils.js";
import { readJsonBody } from "./hooks.js";
import { createSubsystemLogger } from "../logging/subsystem.js";

const logger = createSubsystemLogger("memory-http");

// ============================================================================
// Types
// ============================================================================

interface MemoryStatusResponse {
  enabled: boolean;
  dbSizeMb: number;
  totalFacts: number;
  lastExtractionAt: number | null;
  lastCleanupAt: number | null;
  alertCount: number;
  status: "ok" | "warning" | "critical" | "disabled";
}

interface TopFactItem {
  id: string;
  type: string;
  content: string;
  importance: number;
  lastAccessedAt: number;
  accessCount: number;
}

interface TopFactsResponse {
  items: TopFactItem[];
}

interface DeleteRequest {
  id: string;
}

interface UpdateRequest {
  id: string;
  importance: number;
}

interface MergeRequest {
  sourceId: string;
  targetId: string;
}

// ============================================================================
// Audit Logging
// ============================================================================

interface MemoryActionEvent {
  kind: "memory.action";
  action: "delete" | "update" | "merge";
  timestamp: number;
  factId?: string;
  sourceId?: string;
  targetId?: string;
  importance?: number;
  success: boolean;
  error?: string;
}

function logActionEvent(event: MemoryActionEvent): void {
  const details: Record<string, unknown> = {
    event: event.kind,
    action: event.action,
    success: event.success,
  };

  if (event.factId) details.factId = event.factId;
  if (event.sourceId) details.sourceId = event.sourceId;
  if (event.targetId) details.targetId = event.targetId;
  if (event.importance !== undefined) details.importance = event.importance;
  if (event.error) details.error = event.error;

  if (event.success) {
    logger.info(`Memory action: ${event.action}`, details);
  } else {
    logger.warn(`Memory action failed: ${event.action}`, details);
  }
}

// ============================================================================
// Valid memory types
// ============================================================================

const VALID_MEMORY_TYPES = new Set(["fact", "preference", "decision", "event", "todo"]);
const VALID_ROLES = new Set(["admin", "operator", "analyst", "guest"]);

// ============================================================================
// Handler
// ============================================================================

export type MemoryHttpOptions = {
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
};

/**
 * Handle memory-related HTTP requests.
 * Routes:
 * - GET /api/memory/facts/status
 * - GET /api/memory/facts/top
 */
export async function handleMemoryHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: MemoryHttpOptions,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  // Check if this is a memory API route
  if (!url.pathname.startsWith("/api/memory/facts/")) {
    return false;
  }

  // Auth check (if auth options provided)
  if (opts?.auth) {
    const cfg = loadConfig();
    const token = getBearerToken(req);
    const authResult = await authorizeGatewayConnect({
      auth: opts.auth,
      connectAuth: token ? { token, password: token } : null,
      req,
      trustedProxies: opts.trustedProxies ?? cfg.gateway?.trustedProxies,
    });
    if (!authResult.ok) {
      sendUnauthorized(res);
      return true;
    }
  }

  const subPath = url.pathname.slice("/api/memory/facts/".length);

  // Route: GET /api/memory/facts/status
  if (subPath === "status") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    return handleStatusRequest(res);
  }

  // Route: GET /api/memory/facts/top
  if (subPath === "top") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    return handleTopRequest(req, res, url);
  }

  // Route: GET /api/memory/facts/trace
  if (subPath === "trace") {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, "GET");
      return true;
    }
    return handleTraceRequest(req, res, url);
  }

  // Route: POST /api/memory/facts/delete
  if (subPath === "delete") {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }
    return handleDeleteRequest(req, res);
  }

  // Route: POST /api/memory/facts/update
  if (subPath === "update") {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }
    return handleUpdateRequest(req, res);
  }

  // Route: POST /api/memory/facts/merge
  if (subPath === "merge") {
    if (req.method !== "POST") {
      sendMethodNotAllowed(res, "POST");
      return true;
    }
    return handleMergeRequest(req, res);
  }

  // Not a recognized memory route
  return false;
}

// ============================================================================
// Status Endpoint
// ============================================================================

function handleStatusRequest(res: ServerResponse): boolean {
  const cfg = loadConfig();
  const factsConfig = cfg.factsMemory;

  // Check if memory is disabled
  if (factsConfig?.enabled === false) {
    const response: MemoryStatusResponse = {
      enabled: false,
      dbSizeMb: 0,
      totalFacts: 0,
      lastExtractionAt: null,
      lastCleanupAt: null,
      alertCount: 0,
      status: "disabled",
    };
    sendJson(res, 200, response);
    return true;
  }

  try {
    const manager = createFactsMemoryManager(factsConfig ?? {});
    const summary = getHealthSummary(manager.getStore(), manager.getMarkdownPath(), factsConfig);

    const response: MemoryStatusResponse = {
      enabled: true,
      dbSizeMb: summary.snapshot.dbSizeMb,
      totalFacts: summary.snapshot.totalMemories,
      lastExtractionAt: summary.snapshot.lastExtractionAt
        ? new Date(summary.snapshot.lastExtractionAt).getTime()
        : null,
      lastCleanupAt: summary.snapshot.lastCleanupAt
        ? new Date(summary.snapshot.lastCleanupAt).getTime()
        : null,
      alertCount: summary.activeAlerts.length,
      status: summary.status,
    };

    // Clean up
    manager.close().catch(() => {});

    sendJson(res, 200, response);
    return true;
  } catch (err) {
    sendJson(res, 500, {
      error: { message: `Failed to get memory status: ${String(err)}`, type: "internal_error" },
    });
    return true;
  }
}

// ============================================================================
// Top Facts Endpoint
// ============================================================================

function handleTopRequest(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const cfg = loadConfig();
  const factsConfig = cfg.factsMemory;

  // Check if memory is disabled
  if (factsConfig?.enabled === false) {
    sendJson(res, 200, { items: [] });
    return true;
  }

  // Parse query params
  const limitParam = url.searchParams.get("limit");
  const typeParam = url.searchParams.get("type");

  // Validate limit
  let limit = 10;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 100) {
      sendInvalidRequest(res, "limit must be a number between 1 and 100");
      return true;
    }
    limit = parsed;
  }

  // Validate type
  if (typeParam && !VALID_MEMORY_TYPES.has(typeParam)) {
    sendInvalidRequest(
      res,
      `invalid type: ${typeParam}. Valid types: ${[...VALID_MEMORY_TYPES].join(", ")}`,
    );
    return true;
  }

  try {
    const manager = createFactsMemoryManager(factsConfig ?? {});
    const store = manager.getStore();

    // Get top facts
    let topFacts = getTopFacts(store, limit * 2); // Get extra in case we need to filter

    // Filter by type if specified
    if (typeParam) {
      topFacts = topFacts.filter((f) => f.type === typeParam);
    }

    // Limit results
    topFacts = topFacts.slice(0, limit);

    const items: TopFactItem[] = topFacts.map((f) => ({
      id: f.id,
      type: f.type,
      content: f.content,
      importance: f.importance,
      lastAccessedAt: f.lastAccessedAt * 1000, // Convert to ms
      accessCount: f.accessCount,
    }));

    // Clean up
    manager.close().catch(() => {});

    const response: TopFactsResponse = { items };
    sendJson(res, 200, response);
    return true;
  } catch (err) {
    sendJson(res, 500, {
      error: { message: `Failed to get top facts: ${String(err)}`, type: "internal_error" },
    });
    return true;
  }
}

// ============================================================================
// Delete Endpoint
// ============================================================================

async function handleDeleteRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const cfg = loadConfig();
  const factsConfig = cfg.factsMemory;

  // Check if memory is disabled
  if (factsConfig?.enabled === false) {
    sendInvalidRequest(res, "Facts memory is disabled");
    return true;
  }

  // Parse body
  const body = await readJsonBody(req, 64 * 1024); // 64KB max
  if (!body.ok) {
    const status = body.error === "payload too large" ? 413 : 400;
    sendJson(res, status, { error: { message: body.error, type: "invalid_request" } });
    return true;
  }

  const payload = body.value as DeleteRequest;

  // Validate id
  if (!payload.id || typeof payload.id !== "string") {
    sendInvalidRequest(res, "id is required and must be a string");
    return true;
  }

  try {
    const manager = createFactsMemoryManager(factsConfig ?? {});
    const store = manager.getStore();

    const deleted = store.delete(payload.id);

    // Clean up
    manager.close().catch(() => {});

    if (!deleted) {
      logActionEvent({
        kind: "memory.action",
        action: "delete",
        timestamp: Date.now(),
        factId: payload.id,
        success: false,
        error: "not found",
      });
      sendJson(res, 404, {
        error: { message: `Fact not found: ${payload.id}`, type: "not_found" },
      });
      return true;
    }

    logActionEvent({
      kind: "memory.action",
      action: "delete",
      timestamp: Date.now(),
      factId: payload.id,
      success: true,
    });

    sendJson(res, 200, { success: true });
    return true;
  } catch (err) {
    logActionEvent({
      kind: "memory.action",
      action: "delete",
      timestamp: Date.now(),
      factId: payload.id,
      success: false,
      error: String(err),
    });
    sendJson(res, 500, {
      error: { message: `Failed to delete fact: ${String(err)}`, type: "internal_error" },
    });
    return true;
  }
}

// ============================================================================
// Update Endpoint
// ============================================================================

async function handleUpdateRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const cfg = loadConfig();
  const factsConfig = cfg.factsMemory;

  // Check if memory is disabled
  if (factsConfig?.enabled === false) {
    sendInvalidRequest(res, "Facts memory is disabled");
    return true;
  }

  // Parse body
  const body = await readJsonBody(req, 64 * 1024); // 64KB max
  if (!body.ok) {
    const status = body.error === "payload too large" ? 413 : 400;
    sendJson(res, status, { error: { message: body.error, type: "invalid_request" } });
    return true;
  }

  const payload = body.value as UpdateRequest;

  // Validate id
  if (!payload.id || typeof payload.id !== "string") {
    sendInvalidRequest(res, "id is required and must be a string");
    return true;
  }

  // Validate importance
  if (typeof payload.importance !== "number" || payload.importance < 0 || payload.importance > 1) {
    sendInvalidRequest(res, "importance must be a number between 0 and 1");
    return true;
  }

  try {
    const manager = createFactsMemoryManager(factsConfig ?? {});
    const store = manager.getStore();

    // Check if fact exists
    const existing = store.get(payload.id);
    if (!existing) {
      manager.close().catch(() => {});
      logActionEvent({
        kind: "memory.action",
        action: "update",
        timestamp: Date.now(),
        factId: payload.id,
        importance: payload.importance,
        success: false,
        error: "not found",
      });
      sendJson(res, 404, {
        error: { message: `Fact not found: ${payload.id}`, type: "not_found" },
      });
      return true;
    }

    // Update importance
    store.update(payload.id, { importance: payload.importance });

    // Get updated entry
    const updated = store.get(payload.id);

    // Clean up
    manager.close().catch(() => {});

    logActionEvent({
      kind: "memory.action",
      action: "update",
      timestamp: Date.now(),
      factId: payload.id,
      importance: payload.importance,
      success: true,
    });

    sendJson(res, 200, {
      success: true,
      entry: updated
        ? {
            id: updated.id,
            type: updated.type,
            content: updated.content,
            importance: updated.importance,
            lastAccessedAt: updated.lastAccessedAt * 1000, // Convert to ms
            accessCount: updated.accessCount,
          }
        : null,
    });
    return true;
  } catch (err) {
    logActionEvent({
      kind: "memory.action",
      action: "update",
      timestamp: Date.now(),
      factId: payload.id,
      importance: payload.importance,
      success: false,
      error: String(err),
    });
    sendJson(res, 500, {
      error: { message: `Failed to update fact: ${String(err)}`, type: "internal_error" },
    });
    return true;
  }
}

// ============================================================================
// Merge Endpoint
// ============================================================================

async function handleMergeRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const cfg = loadConfig();
  const factsConfig = cfg.factsMemory;

  // Check if memory is disabled
  if (factsConfig?.enabled === false) {
    sendInvalidRequest(res, "Facts memory is disabled");
    return true;
  }

  // Parse body
  const body = await readJsonBody(req, 64 * 1024); // 64KB max
  if (!body.ok) {
    const status = body.error === "payload too large" ? 413 : 400;
    sendJson(res, status, { error: { message: body.error, type: "invalid_request" } });
    return true;
  }

  const payload = body.value as MergeRequest;

  // Validate sourceId
  if (!payload.sourceId || typeof payload.sourceId !== "string") {
    sendInvalidRequest(res, "sourceId is required and must be a string");
    return true;
  }

  // Validate targetId
  if (!payload.targetId || typeof payload.targetId !== "string") {
    sendInvalidRequest(res, "targetId is required and must be a string");
    return true;
  }

  // sourceId and targetId must be different
  if (payload.sourceId === payload.targetId) {
    sendInvalidRequest(res, "sourceId and targetId must be different");
    return true;
  }

  try {
    const manager = createFactsMemoryManager(factsConfig ?? {});
    const store = manager.getStore();

    // Check if source exists
    const source = store.get(payload.sourceId);
    if (!source) {
      manager.close().catch(() => {});
      logActionEvent({
        kind: "memory.action",
        action: "merge",
        timestamp: Date.now(),
        sourceId: payload.sourceId,
        targetId: payload.targetId,
        success: false,
        error: "source not found",
      });
      sendJson(res, 404, {
        error: { message: `Source fact not found: ${payload.sourceId}`, type: "not_found" },
      });
      return true;
    }

    // Check if target exists
    const target = store.get(payload.targetId);
    if (!target) {
      manager.close().catch(() => {});
      logActionEvent({
        kind: "memory.action",
        action: "merge",
        timestamp: Date.now(),
        sourceId: payload.sourceId,
        targetId: payload.targetId,
        success: false,
        error: "target not found",
      });
      sendJson(res, 404, {
        error: { message: `Target fact not found: ${payload.targetId}`, type: "not_found" },
      });
      return true;
    }

    // Mark source as superseded by target using update
    store.update(payload.sourceId, { supersededBy: payload.targetId });

    // Get updated entries
    const updatedSource = store.get(payload.sourceId);
    const updatedTarget = store.get(payload.targetId);

    // Clean up
    manager.close().catch(() => {});

    logActionEvent({
      kind: "memory.action",
      action: "merge",
      timestamp: Date.now(),
      sourceId: payload.sourceId,
      targetId: payload.targetId,
      success: true,
    });

    sendJson(res, 200, {
      success: true,
      source: updatedSource
        ? {
            id: updatedSource.id,
            type: updatedSource.type,
            content: updatedSource.content,
            importance: updatedSource.importance,
            supersededBy: updatedSource.supersededBy,
          }
        : null,
      target: updatedTarget
        ? {
            id: updatedTarget.id,
            type: updatedTarget.type,
            content: updatedTarget.content,
            importance: updatedTarget.importance,
          }
        : null,
    });
    return true;
  } catch (err) {
    logActionEvent({
      kind: "memory.action",
      action: "merge",
      timestamp: Date.now(),
      sourceId: payload.sourceId,
      targetId: payload.targetId,
      success: false,
      error: String(err),
    });
    sendJson(res, 500, {
      error: { message: `Failed to merge facts: ${String(err)}`, type: "internal_error" },
    });
    return true;
  }
}

// ============================================================================
// Trace Endpoint
// ============================================================================

interface TraceReasonItem {
  id: string;
  type: string;
  content: string;
  score: number;
  source: string;
  snippet: string;
  metadata: Record<string, unknown>;
}

interface TraceResponse {
  query: string;
  timestamp: number;
  included: number;
  excluded: number;
  reasons: TraceReasonItem[];
  context: string;
}

function handleTraceRequest(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const cfg = loadConfig();
  const factsConfig = cfg.factsMemory;

  // Check if memory is disabled
  if (factsConfig?.enabled === false) {
    sendJson(res, 200, {
      query: url.searchParams.get("query") ?? "",
      timestamp: Date.now(),
      included: 0,
      excluded: 0,
      reasons: [],
      context: "",
    } satisfies TraceResponse);
    return true;
  }

  // Parse query params
  const query = url.searchParams.get("query");
  const limitParam = url.searchParams.get("limit");
  const roleParam = url.searchParams.get("role");
  const typeParam = url.searchParams.get("type");

  // Validate query is required
  if (!query || !query.trim()) {
    sendInvalidRequest(res, "query parameter is required");
    return true;
  }

  // Validate limit
  let limit = 10;
  if (limitParam) {
    const parsed = parseInt(limitParam, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 100) {
      sendInvalidRequest(res, "limit must be a number between 1 and 100");
      return true;
    }
    limit = parsed;
  }

  // Validate role
  let role: "admin" | "operator" | "analyst" | "guest" = "operator";
  if (roleParam) {
    if (!VALID_ROLES.has(roleParam)) {
      sendInvalidRequest(
        res,
        `invalid role: ${roleParam}. Valid roles: ${[...VALID_ROLES].join(", ")}`,
      );
      return true;
    }
    role = roleParam as "admin" | "operator" | "analyst" | "guest";
  }

  // Validate type
  if (typeParam && !VALID_MEMORY_TYPES.has(typeParam)) {
    sendInvalidRequest(
      res,
      `invalid type: ${typeParam}. Valid types: ${[...VALID_MEMORY_TYPES].join(", ")}`,
    );
    return true;
  }

  try {
    const manager = createFactsMemoryManager(factsConfig ?? {});
    const store = manager.getStore();

    // Get trace results
    const trace = getRelevantContextWithTrace(store, query, {
      maxResults: limit,
      access: {
        enabled: true,
        role,
        allowedTypes: typeParam
          ? [typeParam as "fact" | "preference" | "decision" | "event" | "todo"]
          : undefined,
      },
    });

    // Map reasons to response format
    const reasons: TraceReasonItem[] = trace.reasons.map((r) => {
      // Get full entry to get content
      const entry = store.get(r.id);
      return {
        id: r.id,
        type: r.type,
        content: entry?.content ?? r.snippet,
        score: r.score,
        source: r.source,
        snippet: r.snippet,
        metadata: {
          importance: entry?.importance ?? 0,
          accessCount: entry?.accessCount ?? 0,
          ...r.metadata,
        },
      };
    });

    // Clean up
    manager.close().catch(() => {});

    const response: TraceResponse = {
      query: trace.query,
      timestamp: trace.timestamp,
      included: trace.memoriesIncluded,
      excluded: trace.access?.excluded ?? 0,
      reasons,
      context: trace.context,
    };

    sendJson(res, 200, response);
    return true;
  } catch (err) {
    sendJson(res, 500, {
      error: { message: `Failed to trace memories: ${String(err)}`, type: "internal_error" },
    });
    return true;
  }
}
