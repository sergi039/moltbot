/**
 * Facts Memory View
 *
 * Renders facts memory status panel and top facts table.
 */

import { html, nothing } from "lit";

import type { FactsMemoryStatus, TopFactItem, TraceResult, TraceReasonItem } from "../controllers/facts-memory";

// ============================================================================
// Types
// ============================================================================

export type FactsMemoryStatusProps = {
  loading: boolean;
  status: FactsMemoryStatus | null;
  error: string | null;
  onRefresh: () => void;
};

export type TopFactsProps = {
  loading: boolean;
  facts: TopFactItem[];
  error: string | null;
  limit: number;
  typeFilter: string | null;
  onRefresh: () => void;
  onLimitChange: (limit: number) => void;
  onTypeChange: (type: string | null) => void;
  // Action handlers
  onDelete?: (factId: string) => void;
  onUpdateImportance?: (factId: string, importance: number) => void;
  onMerge?: (sourceId: string, targetId: string) => void;
  // Edit state
  editingFactId?: string | null;
  editingImportance?: number;
  onStartEdit?: (factId: string, currentImportance: number) => void;
  onCancelEdit?: () => void;
  onConfirmEdit?: () => void;
  onEditImportanceChange?: (importance: number) => void;
};

export type MemorySearchProps = {
  loading: boolean;
  query: string;
  role: string;
  limit: number;
  result: TraceResult | null;
  error: string | null;
  onQueryChange: (query: string) => void;
  onRoleChange: (role: string) => void;
  onLimitChange: (limit: number) => void;
  onSearch: () => void;
  onClear: () => void;
};

// ============================================================================
// Helpers
// ============================================================================

function formatRelativeTime(timestamp: number | null): string {
  if (!timestamp) return "never";

  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

function getStatusClass(status: string): string {
  switch (status) {
    case "ok":
      return "success";
    case "warning":
      return "warning";
    case "critical":
      return "danger";
    case "disabled":
      return "muted";
    default:
      return "";
  }
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "ok":
      return "✓";
    case "warning":
      return "⚠";
    case "critical":
      return "✗";
    case "disabled":
      return "○";
    default:
      return "?";
  }
}

function truncateContent(content: string, maxLen: number = 80): string {
  if (content.length <= maxLen) return content;
  return content.slice(0, maxLen - 3) + "...";
}

// ============================================================================
// Status Panel
// ============================================================================

export function renderFactsMemoryStatus(props: FactsMemoryStatusProps) {
  const { loading, status, error, onRefresh } = props;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Facts Memory</div>
          <div class="card-sub">Memory system health and statistics.</div>
        </div>
        <button class="btn" ?disabled=${loading} @click=${onRefresh}>
          ${loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      ${error
        ? html`<div class="callout danger" style="margin-top: 12px;">${error}</div>`
        : nothing}

      ${status
        ? renderStatusDetails(status)
        : !loading && !error
          ? html`<div class="callout" style="margin-top: 12px;">No status available.</div>`
          : nothing}
    </section>
  `;
}

function renderStatusDetails(status: FactsMemoryStatus) {
  const statusClass = getStatusClass(status.status);
  const statusIcon = getStatusIcon(status.status);

  return html`
    <div class="stats-grid" style="margin-top: 16px;">
      <div class="stat-item">
        <div class="stat-label">Status</div>
        <div class="stat-value ${statusClass}">
          ${statusIcon} ${status.status.toUpperCase()}
        </div>
      </div>

      <div class="stat-item">
        <div class="stat-label">Total Facts</div>
        <div class="stat-value">${status.totalFacts}</div>
      </div>

      <div class="stat-item">
        <div class="stat-label">Database Size</div>
        <div class="stat-value">${status.dbSizeMb.toFixed(2)} MB</div>
      </div>

      <div class="stat-item">
        <div class="stat-label">Alerts</div>
        <div class="stat-value ${status.alertCount > 0 ? "warning" : ""}">
          ${status.alertCount}
        </div>
      </div>

      <div class="stat-item">
        <div class="stat-label">Last Extraction</div>
        <div class="stat-value">${formatRelativeTime(status.lastExtractionAt)}</div>
      </div>

      <div class="stat-item">
        <div class="stat-label">Last Cleanup</div>
        <div class="stat-value">${formatRelativeTime(status.lastCleanupAt)}</div>
      </div>
    </div>
  `;
}

// ============================================================================
// Top Facts Panel
// ============================================================================

export function renderTopFacts(props: TopFactsProps) {
  const { loading, facts, error, limit, typeFilter, onRefresh, onLimitChange, onTypeChange } =
    props;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Top Facts</div>
          <div class="card-sub">Most important and frequently accessed facts.</div>
        </div>
        <button class="btn" ?disabled=${loading} @click=${onRefresh}>
          ${loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <div class="filters-row" style="margin-top: 12px;">
        <div class="filter-group">
          <label class="filter-label">Type</label>
          <select
            class="filter-select"
            .value=${typeFilter ?? ""}
            @change=${(e: Event) => {
              const val = (e.target as HTMLSelectElement).value;
              onTypeChange(val || null);
            }}
          >
            <option value="">All types</option>
            <option value="fact">Fact</option>
            <option value="preference">Preference</option>
            <option value="decision">Decision</option>
            <option value="event">Event</option>
            <option value="todo">Todo</option>
          </select>
        </div>

        <div class="filter-group">
          <label class="filter-label">Limit</label>
          <select
            class="filter-select"
            .value=${String(limit)}
            @change=${(e: Event) => {
              const val = parseInt((e.target as HTMLSelectElement).value, 10);
              onLimitChange(val);
            }}
          >
            <option value="10">10</option>
            <option value="20">20</option>
            <option value="50">50</option>
          </select>
        </div>
      </div>

      ${error
        ? html`<div class="callout danger" style="margin-top: 12px;">${error}</div>`
        : nothing}

      ${facts.length > 0
        ? renderFactsTable(facts, props)
        : !loading && !error
          ? html`<div class="callout" style="margin-top: 12px;">No facts found.</div>`
          : nothing}
    </section>
  `;
}

function renderFactsTable(facts: TopFactItem[], props: TopFactsProps) {
  const hasActions = props.onDelete || props.onUpdateImportance;

  return html`
    <div class="table-container" style="margin-top: 16px;">
      <table class="data-table">
        <thead>
          <tr>
            <th>Type</th>
            <th>Content</th>
            <th>Importance</th>
            <th>Last Accessed</th>
            ${hasActions ? html`<th>Actions</th>` : nothing}
          </tr>
        </thead>
        <tbody>
          ${facts.map((fact) => renderFactRow(fact, props))}
        </tbody>
      </table>
    </div>
  `;
}

function renderFactRow(fact: TopFactItem, props: TopFactsProps) {
  const hasActions = props.onDelete || props.onUpdateImportance;
  const isEditing = props.editingFactId === fact.id;

  return html`
    <tr>
      <td>
        <span class="chip type-${fact.type}">${fact.type}</span>
      </td>
      <td class="content-cell" title="${fact.content}">
        ${truncateContent(fact.content)}
      </td>
      <td>
        ${isEditing
          ? renderImportanceEdit(fact, props)
          : html`
              <span class="importance-bar">
                <span
                  class="importance-fill"
                  style="width: ${Math.round(fact.importance * 100)}%"
                ></span>
                <span class="importance-text">${(fact.importance * 100).toFixed(0)}%</span>
              </span>
            `}
      </td>
      <td>${formatRelativeTime(fact.lastAccessedAt)}</td>
      ${hasActions ? renderFactActions(fact, props) : nothing}
    </tr>
  `;
}

function renderImportanceEdit(fact: TopFactItem, props: TopFactsProps) {
  const value = props.editingImportance ?? fact.importance;

  return html`
    <div class="importance-edit">
      <input
        type="range"
        min="0"
        max="100"
        .value=${String(Math.round(value * 100))}
        @input=${(e: Event) => {
          const val = parseInt((e.target as HTMLInputElement).value, 10) / 100;
          props.onEditImportanceChange?.(val);
        }}
        style="width: 80px;"
      />
      <span class="importance-value">${Math.round(value * 100)}%</span>
      <button
        class="btn btn-small btn-primary"
        @click=${() => props.onConfirmEdit?.()}
        title="Save"
      >
        ✓
      </button>
      <button
        class="btn btn-small"
        @click=${() => props.onCancelEdit?.()}
        title="Cancel"
      >
        ✗
      </button>
    </div>
  `;
}

function renderFactActions(fact: TopFactItem, props: TopFactsProps) {
  const isEditing = props.editingFactId === fact.id;

  return html`
    <td class="actions-cell">
      ${!isEditing
        ? html`
            ${props.onUpdateImportance
              ? html`
                  <button
                    class="btn btn-small"
                    @click=${() => props.onStartEdit?.(fact.id, fact.importance)}
                    title="Edit importance"
                  >
                    ✎
                  </button>
                `
              : nothing}
            ${props.onDelete
              ? html`
                  <button
                    class="btn btn-small btn-danger"
                    @click=${() => {
                      if (confirm(`Delete fact: "${truncateContent(fact.content, 50)}"?`)) {
                        props.onDelete?.(fact.id);
                      }
                    }}
                    title="Delete"
                  >
                    ✕
                  </button>
                `
              : nothing}
          `
        : nothing}
    </td>
  `;
}

// ============================================================================
// Combined Panel
// ============================================================================

export type FactsMemoryPanelProps = {
  statusProps: FactsMemoryStatusProps;
  topFactsProps: TopFactsProps;
};

export function renderFactsMemoryPanel(props: FactsMemoryPanelProps) {
  return html`
    <div class="facts-memory-panel">
      ${renderFactsMemoryStatus(props.statusProps)}
      ${renderTopFacts(props.topFactsProps)}
    </div>
  `;
}

// ============================================================================
// Memory Search Panel
// ============================================================================

export function renderMemorySearch(props: MemorySearchProps) {
  const { loading, query, role, limit, result, error, onQueryChange, onRoleChange, onLimitChange, onSearch, onClear } = props;

  return html`
    <section class="card">
      <div class="row" style="justify-content: space-between;">
        <div>
          <div class="card-title">Memory Search</div>
          <div class="card-sub">Search memories with trace (explainability).</div>
        </div>
      </div>

      <div class="search-form" style="margin-top: 12px;">
        <div class="search-row" style="display: flex; gap: 8px; align-items: flex-end;">
          <div class="filter-group" style="flex: 1;">
            <label class="filter-label">Query</label>
            <input
              type="text"
              class="filter-input"
              placeholder="Search memories..."
              .value=${query}
              @input=${(e: Event) => onQueryChange((e.target as HTMLInputElement).value)}
              @keydown=${(e: KeyboardEvent) => {
                if (e.key === "Enter") onSearch();
              }}
            />
          </div>
          <div class="filter-group">
            <label class="filter-label">Role</label>
            <select
              class="filter-select"
              .value=${role}
              @change=${(e: Event) => onRoleChange((e.target as HTMLSelectElement).value)}
            >
              <option value="operator">Operator</option>
              <option value="admin">Admin</option>
              <option value="analyst">Analyst</option>
              <option value="guest">Guest</option>
            </select>
          </div>
          <div class="filter-group">
            <label class="filter-label">Limit</label>
            <select
              class="filter-select"
              .value=${String(limit)}
              @change=${(e: Event) => onLimitChange(parseInt((e.target as HTMLSelectElement).value, 10))}
            >
              <option value="5">5</option>
              <option value="10">10</option>
              <option value="20">20</option>
            </select>
          </div>
          <button class="btn btn-primary" ?disabled=${loading || !query.trim()} @click=${onSearch}>
            ${loading ? "Searching..." : "Search"}
          </button>
          ${result ? html`<button class="btn" @click=${onClear}>Clear</button>` : nothing}
        </div>
      </div>

      ${error ? html`<div class="callout danger" style="margin-top: 12px;">${error}</div>` : nothing}

      ${result ? renderSearchResults(result) : nothing}
    </section>
  `;
}

function renderSearchResults(result: TraceResult) {
  return html`
    <div class="search-results" style="margin-top: 16px;">
      <div class="search-stats" style="margin-bottom: 12px; font-size: 0.9em; color: var(--text-muted);">
        Found <strong>${result.included}</strong> memories (${result.excluded} excluded by role)
      </div>

      ${result.reasons.length > 0
        ? html`
            <div class="results-list">
              ${result.reasons.map((reason) => renderSearchReason(reason))}
            </div>
          `
        : html`<div class="callout">No memories found matching the query.</div>`}

      ${result.context
        ? html`
            <details class="context-details" style="margin-top: 16px;">
              <summary style="cursor: pointer; font-weight: 500;">Generated Context Preview</summary>
              <pre class="context-preview" style="margin-top: 8px; padding: 12px; background: var(--bg-alt); border-radius: 4px; overflow-x: auto; font-size: 0.85em; white-space: pre-wrap;">${result.context}</pre>
            </details>
          `
        : nothing}
    </div>
  `;
}

function renderSearchReason(reason: TraceReasonItem) {
  const importance = typeof reason.metadata.importance === "number" ? reason.metadata.importance : 0;
  const accessCount = typeof reason.metadata.accessCount === "number" ? reason.metadata.accessCount : 0;

  return html`
    <div class="search-reason" style="padding: 12px; border: 1px solid var(--border); border-radius: 4px; margin-bottom: 8px;">
      <div class="reason-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
        <div>
          <span class="chip type-${reason.type}" style="margin-right: 8px;">${reason.type}</span>
          <span class="chip source-${reason.source}" style="background: var(--bg-alt);">${reason.source}</span>
        </div>
        <div class="score" style="font-size: 0.9em;">
          Score: <strong>${(reason.score * 100).toFixed(0)}%</strong>
        </div>
      </div>
      <div class="reason-content" style="margin-bottom: 8px;">${reason.content}</div>
      <div class="reason-meta" style="font-size: 0.85em; color: var(--text-muted);">
        Importance: ${(importance * 100).toFixed(0)}% • Access count: ${accessCount}
      </div>
    </div>
  `;
}
