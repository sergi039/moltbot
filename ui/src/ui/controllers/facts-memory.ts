/**
 * Facts Memory Controller
 *
 * Manages state and API calls for facts memory status and top facts.
 * Uses HTTP API endpoints at /api/memory/facts/*
 */

// ============================================================================
// Types
// ============================================================================

export interface FactsMemoryStatus {
  enabled: boolean;
  dbSizeMb: number;
  totalFacts: number;
  lastExtractionAt: number | null;
  lastCleanupAt: number | null;
  alertCount: number;
  status: "ok" | "warning" | "critical" | "disabled";
}

export interface TopFactItem {
  id: string;
  type: string;
  content: string;
  importance: number;
  lastAccessedAt: number;
  accessCount: number;
}

export interface TraceReasonItem {
  id: string;
  type: string;
  content: string;
  score: number;
  source: string;
  snippet: string;
  metadata: Record<string, unknown>;
}

export interface TraceResult {
  query: string;
  timestamp: number;
  included: number;
  excluded: number;
  reasons: TraceReasonItem[];
  context: string;
}

// State interface that matches app.ts state properties
export interface FactsMemoryState {
  factsMemoryLoading: boolean;
  factsMemoryStatus: FactsMemoryStatus | null;
  factsMemoryError: string | null;
  topFactsLoading: boolean;
  topFacts: TopFactItem[];
  topFactsError: string | null;
  topFactsLimit: number;
  topFactsTypeFilter: string | null;
  // Search state
  searchQuery: string;
  searchLoading: boolean;
  searchResult: TraceResult | null;
  searchError: string | null;
  searchRole: string;
  searchLimit: number;
  // Gateway connection info from settings
  settings: {
    gatewayUrl: string;
    token: string;
  };
  // Device token from WebSocket hello (takes precedence over settings.token)
  hello?: {
    auth?: {
      deviceToken?: string;
    };
  } | null;
}

// ============================================================================
// API Helpers
// ============================================================================

function resolveHttpBaseUrl(wsUrl: string): string {
  // Convert WebSocket URL to HTTP URL
  // ws://host:port -> http://host:port
  // wss://host:port -> https://host:port
  if (wsUrl.startsWith("wss://")) {
    return wsUrl.replace("wss://", "https://");
  }
  if (wsUrl.startsWith("ws://")) {
    return wsUrl.replace("ws://", "http://");
  }
  return wsUrl;
}

function buildHeaders(token: string | null): HeadersInit {
  const headers: HeadersInit = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Resolve the best auth token to use.
 * Priority: deviceToken (from hello) > settings.token
 */
function resolveAuthToken(state: FactsMemoryState): string | null {
  // Device token from WebSocket session takes precedence
  const deviceToken = state.hello?.auth?.deviceToken;
  if (deviceToken) {
    return deviceToken;
  }
  // Fall back to settings token
  return state.settings.token || null;
}

async function fetchJson<T>(url: string, token: string | null): Promise<T> {
  const response = await fetch(url, {
    method: "GET",
    headers: buildHeaders(token),
  });

  if (!response.ok) {
    const text = await response.text();
    // Provide helpful message for auth errors
    if (response.status === 401) {
      throw new Error(
        "Unauthorized. Connect to gateway with device pairing, or set token in Settings → Gateway Token.",
      );
    }
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, token: string | null, body: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: buildHeaders(token),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HTTP ${response.status}: ${text}`);
  }

  return response.json() as Promise<T>;
}

// ============================================================================
// Load Functions
// ============================================================================

/**
 * Load facts memory status from API.
 */
export async function loadFactsMemoryStatus(state: FactsMemoryState): Promise<void> {
  if (state.factsMemoryLoading) return;

  state.factsMemoryLoading = true;
  state.factsMemoryError = null;

  try {
    const baseUrl = resolveHttpBaseUrl(state.settings.gatewayUrl);
    const url = `${baseUrl}/api/memory/facts/status`;
    const data = await fetchJson<FactsMemoryStatus>(url, resolveAuthToken(state));
    state.factsMemoryStatus = data;
  } catch (err) {
    state.factsMemoryError = String(err);
    state.factsMemoryStatus = null;
  } finally {
    state.factsMemoryLoading = false;
  }
}

/**
 * Load top facts from API.
 */
export async function loadTopFacts(state: FactsMemoryState): Promise<void> {
  if (state.topFactsLoading) return;

  state.topFactsLoading = true;
  state.topFactsError = null;

  try {
    const baseUrl = resolveHttpBaseUrl(state.settings.gatewayUrl);
    let url = `${baseUrl}/api/memory/facts/top?limit=${state.topFactsLimit}`;
    if (state.topFactsTypeFilter) {
      url += `&type=${encodeURIComponent(state.topFactsTypeFilter)}`;
    }

    const data = await fetchJson<{ items: TopFactItem[] }>(url, resolveAuthToken(state));
    state.topFacts = data.items;
  } catch (err) {
    state.topFactsError = String(err);
    state.topFacts = [];
  } finally {
    state.topFactsLoading = false;
  }
}

/**
 * Load both status and top facts.
 */
export async function loadFactsMemory(state: FactsMemoryState): Promise<void> {
  await Promise.all([loadFactsMemoryStatus(state), loadTopFacts(state)]);
}

/**
 * Update filter and reload top facts.
 */
export async function setTopFactsFilter(
  state: FactsMemoryState,
  typeFilter: string | null,
): Promise<void> {
  state.topFactsTypeFilter = typeFilter;
  await loadTopFacts(state);
}

/**
 * Update limit and reload top facts.
 */
export async function setTopFactsLimit(state: FactsMemoryState, limit: number): Promise<void> {
  state.topFactsLimit = limit;
  await loadTopFacts(state);
}

// ============================================================================
// Action Functions
// ============================================================================

/**
 * Delete a fact by ID.
 */
export async function deleteFact(
  state: FactsMemoryState,
  factId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const baseUrl = resolveHttpBaseUrl(state.settings.gatewayUrl);
    const url = `${baseUrl}/api/memory/facts/delete`;
    await postJson<{ success: boolean }>(url, resolveAuthToken(state), { id: factId });

    // Optimistic update: remove from local state
    state.topFacts = state.topFacts.filter((f) => f.id !== factId);

    // Reload status to update counts
    await loadFactsMemoryStatus(state);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Update a fact's importance.
 */
export async function updateFactImportance(
  state: FactsMemoryState,
  factId: string,
  importance: number,
): Promise<{ success: boolean; error?: string }> {
  try {
    const baseUrl = resolveHttpBaseUrl(state.settings.gatewayUrl);
    const url = `${baseUrl}/api/memory/facts/update`;
    const result = await postJson<{ success: boolean; entry: TopFactItem }>(
      url,
      resolveAuthToken(state),
      { id: factId, importance },
    );

    // Optimistic update: update local state
    const index = state.topFacts.findIndex((f) => f.id === factId);
    if (index !== -1 && result.entry) {
      state.topFacts = [
        ...state.topFacts.slice(0, index),
        result.entry,
        ...state.topFacts.slice(index + 1),
      ];
    }

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

/**
 * Merge two facts (mark source as superseded by target).
 */
export async function mergeFacts(
  state: FactsMemoryState,
  sourceId: string,
  targetId: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const baseUrl = resolveHttpBaseUrl(state.settings.gatewayUrl);
    const url = `${baseUrl}/api/memory/facts/merge`;
    await postJson<{ success: boolean }>(url, resolveAuthToken(state), { sourceId, targetId });

    // Optimistic update: remove source from local state (it's now superseded)
    state.topFacts = state.topFacts.filter((f) => f.id !== sourceId);

    // Reload status to update counts
    await loadFactsMemoryStatus(state);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

// ============================================================================
// Search Functions
// ============================================================================

/**
 * Search memories with trace (explainability).
 */
export async function searchMemories(state: FactsMemoryState): Promise<void> {
  if (state.searchLoading || !state.searchQuery.trim()) return;

  state.searchLoading = true;
  state.searchError = null;

  try {
    const baseUrl = resolveHttpBaseUrl(state.settings.gatewayUrl);
    let url = `${baseUrl}/api/memory/facts/trace?query=${encodeURIComponent(state.searchQuery)}`;
    url += `&limit=${state.searchLimit}`;
    if (state.searchRole) {
      url += `&role=${encodeURIComponent(state.searchRole)}`;
    }

    const data = await fetchJson<TraceResult>(url, resolveAuthToken(state));
    state.searchResult = data;
  } catch (err) {
    state.searchError = String(err);
    state.searchResult = null;
  } finally {
    state.searchLoading = false;
  }
}

/**
 * Update search query.
 */
export function setSearchQuery(state: FactsMemoryState, query: string): void {
  state.searchQuery = query;
}

/**
 * Update search role filter.
 */
export function setSearchRole(state: FactsMemoryState, role: string): void {
  state.searchRole = role;
}

/**
 * Update search limit.
 */
export function setSearchLimit(state: FactsMemoryState, limit: number): void {
  state.searchLimit = limit;
}

/**
 * Clear search results.
 */
export function clearSearch(state: FactsMemoryState): void {
  state.searchQuery = "";
  state.searchResult = null;
  state.searchError = null;
}
