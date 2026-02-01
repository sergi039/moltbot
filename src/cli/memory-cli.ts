import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { loadConfig } from "../config/config.js";
import { resolveSessionTranscriptsDirForAgent } from "../config/sessions/paths.js";
import { setVerbose } from "../globals.js";
import { withProgress, withProgressTotals } from "./progress.js";
import { formatErrorMessage, withManager } from "./cli-utils.js";
import { getMemorySearchManager, type MemorySearchManagerResult } from "../memory/index.js";
import { listMemoryFiles, normalizeExtraMemoryPaths } from "../memory/internal.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import { resolveStateDir } from "../config/paths.js";
import { shortenHomeInString, shortenHomePath } from "../utils.js";
import {
  createFactsMemoryManager,
  runCleanup,
  getCleanupStats,
  vacuumDatabase,
  getRelevantContextWithTrace,
  type CleanupResult,
  type CleanupStats,
  type RetrievalTrace,
} from "../memory/facts/index.js";
import {
  getHealthSummary,
  getRecentAlerts,
  getAlertThresholds,
  type HealthSnapshot,
  type HealthAlert,
} from "../memory/facts/health.js";
import { triggerHealthCheckNow } from "../memory/facts/scheduler.js";
import { runRepair, type RepairOptions, type RepairResult } from "../memory/facts/repair.js";
import { exportToJsonl, type ExportResult, type ExportOptions } from "../memory/facts/export.js";
import { importFromJsonl, type ImportOptions, type ImportResult } from "../memory/facts/import.js";
import {
  type RedactionPatternType,
  validatePatternTypes,
  getAvailablePatterns,
  DEFAULT_REDACTION_PATTERNS,
} from "../memory/facts/redaction.js";
import {
  type AccessRole,
  filterByRole,
  isValidRole,
  getAvailableRoles,
  createAuditEvent,
  logAuditEvent,
  getRoleConfig,
} from "../memory/facts/access.js";
import type { MemoryType } from "../memory/facts/types.js";

/** Get allowed memory types for a role */
function getRoleAllowedTypes(role: AccessRole): MemoryType[] {
  const config = getRoleConfig(role);
  return config.allowedTypes;
}
import { promptYesNo } from "./prompt.js";

type MemoryCommandOptions = {
  agent?: string;
  json?: boolean;
  deep?: boolean;
  index?: boolean;
  verbose?: boolean;
};

type MemoryManager = NonNullable<MemorySearchManagerResult["manager"]>;

type MemorySourceName = "memory" | "sessions";

type SourceScan = {
  source: MemorySourceName;
  totalFiles: number | null;
  issues: string[];
};

type MemorySourceScan = {
  sources: SourceScan[];
  totalFiles: number | null;
  issues: string[];
};

function formatSourceLabel(source: string, workspaceDir: string, agentId: string): string {
  if (source === "memory") {
    return shortenHomeInString(
      `memory (MEMORY.md + ${path.join(workspaceDir, "memory")}${path.sep}*.md)`,
    );
  }
  if (source === "sessions") {
    const stateDir = resolveStateDir(process.env, os.homedir);
    return shortenHomeInString(
      `sessions (${path.join(stateDir, "agents", agentId, "sessions")}${path.sep}*.jsonl)`,
    );
  }
  return source;
}

function resolveAgent(cfg: ReturnType<typeof loadConfig>, agent?: string) {
  const trimmed = agent?.trim();
  if (trimmed) return trimmed;
  return resolveDefaultAgentId(cfg);
}

function resolveAgentIds(cfg: ReturnType<typeof loadConfig>, agent?: string): string[] {
  const trimmed = agent?.trim();
  if (trimmed) return [trimmed];
  const list = cfg.agents?.list ?? [];
  if (list.length > 0) {
    return list.map((entry) => entry.id).filter(Boolean);
  }
  return [resolveDefaultAgentId(cfg)];
}

function formatExtraPaths(workspaceDir: string, extraPaths: string[]): string[] {
  return normalizeExtraMemoryPaths(workspaceDir, extraPaths).map((entry) => shortenHomePath(entry));
}

async function checkReadableFile(pathname: string): Promise<{ exists: boolean; issue?: string }> {
  try {
    await fs.access(pathname, fsSync.constants.R_OK);
    return { exists: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { exists: false };
    return {
      exists: true,
      issue: `${shortenHomePath(pathname)} not readable (${code ?? "error"})`,
    };
  }
}

async function scanSessionFiles(agentId: string): Promise<SourceScan> {
  const issues: string[] = [];
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId);
  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const totalFiles = entries.filter(
      (entry) => entry.isFile() && entry.name.endsWith(".jsonl"),
    ).length;
    return { source: "sessions", totalFiles, issues };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`sessions directory missing (${shortenHomePath(sessionsDir)})`);
      return { source: "sessions", totalFiles: 0, issues };
    }
    issues.push(
      `sessions directory not accessible (${shortenHomePath(sessionsDir)}): ${code ?? "error"}`,
    );
    return { source: "sessions", totalFiles: null, issues };
  }
}

async function scanMemoryFiles(
  workspaceDir: string,
  extraPaths: string[] = [],
): Promise<SourceScan> {
  const issues: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  const primary = await checkReadableFile(memoryFile);
  const alt = await checkReadableFile(altMemoryFile);
  if (primary.issue) issues.push(primary.issue);
  if (alt.issue) issues.push(alt.issue);

  const resolvedExtraPaths = normalizeExtraMemoryPaths(workspaceDir, extraPaths);
  for (const extraPath of resolvedExtraPaths) {
    try {
      const stat = await fs.lstat(extraPath);
      if (stat.isSymbolicLink()) continue;
      const extraCheck = await checkReadableFile(extraPath);
      if (extraCheck.issue) issues.push(extraCheck.issue);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        issues.push(`additional memory path missing (${shortenHomePath(extraPath)})`);
      } else {
        issues.push(
          `additional memory path not accessible (${shortenHomePath(extraPath)}): ${code ?? "error"}`,
        );
      }
    }
  }

  let dirReadable: boolean | null = null;
  try {
    await fs.access(memoryDir, fsSync.constants.R_OK);
    dirReadable = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      issues.push(`memory directory missing (${shortenHomePath(memoryDir)})`);
      dirReadable = false;
    } else {
      issues.push(
        `memory directory not accessible (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let listed: string[] = [];
  let listedOk = false;
  try {
    listed = await listMemoryFiles(workspaceDir, resolvedExtraPaths);
    listedOk = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (dirReadable !== null) {
      issues.push(
        `memory directory scan failed (${shortenHomePath(memoryDir)}): ${code ?? "error"}`,
      );
      dirReadable = null;
    }
  }

  let totalFiles: number | null = 0;
  if (dirReadable === null) {
    totalFiles = null;
  } else {
    const files = new Set<string>(listedOk ? listed : []);
    if (!listedOk) {
      if (primary.exists) files.add(memoryFile);
      if (alt.exists) files.add(altMemoryFile);
    }
    totalFiles = files.size;
  }

  if ((totalFiles ?? 0) === 0 && issues.length === 0) {
    issues.push(`no memory files found in ${shortenHomePath(workspaceDir)}`);
  }

  return { source: "memory", totalFiles, issues };
}

async function scanMemorySources(params: {
  workspaceDir: string;
  agentId: string;
  sources: MemorySourceName[];
  extraPaths?: string[];
}): Promise<MemorySourceScan> {
  const scans: SourceScan[] = [];
  const extraPaths = params.extraPaths ?? [];
  for (const source of params.sources) {
    if (source === "memory") {
      scans.push(await scanMemoryFiles(params.workspaceDir, extraPaths));
    }
    if (source === "sessions") {
      scans.push(await scanSessionFiles(params.agentId));
    }
  }
  const issues = scans.flatMap((scan) => scan.issues);
  const totals = scans.map((scan) => scan.totalFiles);
  const numericTotals = totals.filter((total): total is number => total !== null);
  const totalFiles = totals.some((total) => total === null)
    ? null
    : numericTotals.reduce((sum, total) => sum + total, 0);
  return { sources: scans, totalFiles, issues };
}

export async function runMemoryStatus(opts: MemoryCommandOptions) {
  setVerbose(Boolean(opts.verbose));
  const cfg = loadConfig();
  const agentIds = resolveAgentIds(cfg, opts.agent);
  const allResults: Array<{
    agentId: string;
    status: ReturnType<MemoryManager["status"]>;
    embeddingProbe?: Awaited<ReturnType<MemoryManager["probeEmbeddingAvailability"]>>;
    indexError?: string;
    scan?: MemorySourceScan;
  }> = [];

  for (const agentId of agentIds) {
    await withManager<MemoryManager>({
      getManager: () => getMemorySearchManager({ cfg, agentId }),
      onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
      onCloseError: (err) =>
        defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
      close: (manager) => manager.close(),
      run: async (manager) => {
        const deep = Boolean(opts.deep || opts.index);
        let embeddingProbe:
          | Awaited<ReturnType<typeof manager.probeEmbeddingAvailability>>
          | undefined;
        let indexError: string | undefined;
        if (deep) {
          await withProgress({ label: "Checking memory…", total: 2 }, async (progress) => {
            progress.setLabel("Probing vector…");
            await manager.probeVectorAvailability();
            progress.tick();
            progress.setLabel("Probing embeddings…");
            embeddingProbe = await manager.probeEmbeddingAvailability();
            progress.tick();
          });
          if (opts.index) {
            await withProgressTotals(
              {
                label: "Indexing memory…",
                total: 0,
                fallback: opts.verbose ? "line" : undefined,
              },
              async (update, progress) => {
                try {
                  await manager.sync({
                    reason: "cli",
                    progress: (syncUpdate) => {
                      update({
                        completed: syncUpdate.completed,
                        total: syncUpdate.total,
                        label: syncUpdate.label,
                      });
                      if (syncUpdate.label) progress.setLabel(syncUpdate.label);
                    },
                  });
                } catch (err) {
                  indexError = formatErrorMessage(err);
                  defaultRuntime.error(`Memory index failed: ${indexError}`);
                  process.exitCode = 1;
                }
              },
            );
          }
        } else {
          await manager.probeVectorAvailability();
        }
        const status = manager.status();
        const sources = (
          status.sources?.length ? status.sources : ["memory"]
        ) as MemorySourceName[];
        const scan = await scanMemorySources({
          workspaceDir: status.workspaceDir,
          agentId,
          sources,
          extraPaths: status.extraPaths,
        });
        allResults.push({ agentId, status, embeddingProbe, indexError, scan });
      },
    });
  }

  if (opts.json) {
    defaultRuntime.log(JSON.stringify(allResults, null, 2));
    return;
  }

  const rich = isRich();
  const heading = (text: string) => colorize(rich, theme.heading, text);
  const muted = (text: string) => colorize(rich, theme.muted, text);
  const info = (text: string) => colorize(rich, theme.info, text);
  const success = (text: string) => colorize(rich, theme.success, text);
  const warn = (text: string) => colorize(rich, theme.warn, text);
  const accent = (text: string) => colorize(rich, theme.accent, text);
  const label = (text: string) => muted(`${text}:`);

  for (const result of allResults) {
    const { agentId, status, embeddingProbe, indexError, scan } = result;
    const totalFiles = scan?.totalFiles ?? null;
    const indexedLabel =
      totalFiles === null
        ? `${status.files}/? files · ${status.chunks} chunks`
        : `${status.files}/${totalFiles} files · ${status.chunks} chunks`;
    if (opts.index) {
      const line = indexError ? `Memory index failed: ${indexError}` : "Memory index complete.";
      defaultRuntime.log(line);
    }
    const extraPaths = formatExtraPaths(status.workspaceDir, status.extraPaths ?? []);
    const lines = [
      `${heading("Memory Search")} ${muted(`(${agentId})`)}`,
      `${label("Provider")} ${info(status.provider)} ${muted(
        `(requested: ${status.requestedProvider})`,
      )}`,
      `${label("Model")} ${info(status.model)}`,
      status.sources?.length ? `${label("Sources")} ${info(status.sources.join(", "))}` : null,
      extraPaths.length ? `${label("Extra paths")} ${info(extraPaths.join(", "))}` : null,
      `${label("Indexed")} ${success(indexedLabel)}`,
      `${label("Dirty")} ${status.dirty ? warn("yes") : muted("no")}`,
      `${label("Store")} ${info(shortenHomePath(status.dbPath))}`,
      `${label("Workspace")} ${info(shortenHomePath(status.workspaceDir))}`,
    ].filter(Boolean) as string[];
    if (embeddingProbe) {
      const state = embeddingProbe.ok ? "ready" : "unavailable";
      const stateColor = embeddingProbe.ok ? theme.success : theme.warn;
      lines.push(`${label("Embeddings")} ${colorize(rich, stateColor, state)}`);
      if (embeddingProbe.error) {
        lines.push(`${label("Embeddings error")} ${warn(embeddingProbe.error)}`);
      }
    }
    if (status.sourceCounts?.length) {
      lines.push(label("By source"));
      for (const entry of status.sourceCounts) {
        const total = scan?.sources.find(
          (scanEntry) => scanEntry.source === entry.source,
        )?.totalFiles;
        const counts =
          total === null
            ? `${entry.files}/? files · ${entry.chunks} chunks`
            : `${entry.files}/${total} files · ${entry.chunks} chunks`;
        lines.push(`  ${accent(entry.source)} ${muted("·")} ${muted(counts)}`);
      }
    }
    if (status.fallback) {
      lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
    }
    if (status.vector) {
      const vectorState = status.vector.enabled
        ? status.vector.available === undefined
          ? "unknown"
          : status.vector.available
            ? "ready"
            : "unavailable"
        : "disabled";
      const vectorColor =
        vectorState === "ready"
          ? theme.success
          : vectorState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("Vector")} ${colorize(rich, vectorColor, vectorState)}`);
      if (status.vector.dims) {
        lines.push(`${label("Vector dims")} ${info(String(status.vector.dims))}`);
      }
      if (status.vector.extensionPath) {
        lines.push(`${label("Vector path")} ${info(shortenHomePath(status.vector.extensionPath))}`);
      }
      if (status.vector.loadError) {
        lines.push(`${label("Vector error")} ${warn(status.vector.loadError)}`);
      }
    }
    if (status.fts) {
      const ftsState = status.fts.enabled
        ? status.fts.available
          ? "ready"
          : "unavailable"
        : "disabled";
      const ftsColor =
        ftsState === "ready"
          ? theme.success
          : ftsState === "unavailable"
            ? theme.warn
            : theme.muted;
      lines.push(`${label("FTS")} ${colorize(rich, ftsColor, ftsState)}`);
      if (status.fts.error) {
        lines.push(`${label("FTS error")} ${warn(status.fts.error)}`);
      }
    }
    if (status.cache) {
      const cacheState = status.cache.enabled ? "enabled" : "disabled";
      const cacheColor = status.cache.enabled ? theme.success : theme.muted;
      const suffix =
        status.cache.enabled && typeof status.cache.entries === "number"
          ? ` (${status.cache.entries} entries)`
          : "";
      lines.push(`${label("Embedding cache")} ${colorize(rich, cacheColor, cacheState)}${suffix}`);
      if (status.cache.enabled && typeof status.cache.maxEntries === "number") {
        lines.push(`${label("Cache cap")} ${info(String(status.cache.maxEntries))}`);
      }
    }
    if (status.batch) {
      const batchState = status.batch.enabled ? "enabled" : "disabled";
      const batchColor = status.batch.enabled ? theme.success : theme.warn;
      const batchSuffix = ` (failures ${status.batch.failures}/${status.batch.limit})`;
      lines.push(
        `${label("Batch")} ${colorize(rich, batchColor, batchState)}${muted(batchSuffix)}`,
      );
      if (status.batch.lastError) {
        lines.push(`${label("Batch error")} ${warn(status.batch.lastError)}`);
      }
    }
    if (status.fallback?.reason) {
      lines.push(muted(status.fallback.reason));
    }
    if (indexError) {
      lines.push(`${label("Index error")} ${warn(indexError)}`);
    }
    if (scan?.issues.length) {
      lines.push(label("Issues"));
      for (const issue of scan.issues) {
        lines.push(`  ${warn(issue)}`);
      }
    }
    defaultRuntime.log(lines.join("\n"));
    defaultRuntime.log("");
  }
}

export function registerMemoryCli(program: Command) {
  const memory = program
    .command("memory")
    .description("Memory search tools")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/memory", "docs.openclaw.ai/cli/memory")}\n`,
    );

  memory
    .command("status")
    .description("Show memory search index status")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--json", "Print JSON")
    .option("--deep", "Probe embedding provider availability")
    .option("--index", "Reindex if dirty (implies --deep)")
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions) => {
      await runMemoryStatus(opts);
    });

  memory
    .command("index")
    .description("Reindex memory files")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--force", "Force full reindex", false)
    .option("--verbose", "Verbose logging", false)
    .action(async (opts: MemoryCommandOptions & { force?: boolean }) => {
      setVerbose(Boolean(opts.verbose));
      const cfg = loadConfig();
      const agentIds = resolveAgentIds(cfg, opts.agent);
      for (const agentId of agentIds) {
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: (manager) => manager.close(),
          run: async (manager) => {
            try {
              if (opts.verbose) {
                const status = manager.status();
                const rich = isRich();
                const heading = (text: string) => colorize(rich, theme.heading, text);
                const muted = (text: string) => colorize(rich, theme.muted, text);
                const info = (text: string) => colorize(rich, theme.info, text);
                const warn = (text: string) => colorize(rich, theme.warn, text);
                const label = (text: string) => muted(`${text}:`);
                const sourceLabels = status.sources.map((source) =>
                  formatSourceLabel(source, status.workspaceDir, agentId),
                );
                const extraPaths = formatExtraPaths(status.workspaceDir, status.extraPaths ?? []);
                const lines = [
                  `${heading("Memory Index")} ${muted(`(${agentId})`)}`,
                  `${label("Provider")} ${info(status.provider)} ${muted(
                    `(requested: ${status.requestedProvider})`,
                  )}`,
                  `${label("Model")} ${info(status.model)}`,
                  sourceLabels.length
                    ? `${label("Sources")} ${info(sourceLabels.join(", "))}`
                    : null,
                  extraPaths.length
                    ? `${label("Extra paths")} ${info(extraPaths.join(", "))}`
                    : null,
                ].filter(Boolean) as string[];
                if (status.fallback) {
                  lines.push(`${label("Fallback")} ${warn(status.fallback.from)}`);
                }
                defaultRuntime.log(lines.join("\n"));
                defaultRuntime.log("");
              }
              const startedAt = Date.now();
              let lastLabel = "Indexing memory…";
              let lastCompleted = 0;
              let lastTotal = 0;
              const formatElapsed = () => {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const seconds = Math.floor(elapsedMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const formatEta = () => {
                if (lastTotal <= 0 || lastCompleted <= 0) return null;
                const elapsedMs = Math.max(1, Date.now() - startedAt);
                const rate = lastCompleted / elapsedMs;
                if (!Number.isFinite(rate) || rate <= 0) return null;
                const remainingMs = Math.max(0, (lastTotal - lastCompleted) / rate);
                const seconds = Math.floor(remainingMs / 1000);
                const minutes = Math.floor(seconds / 60);
                const remainingSeconds = seconds % 60;
                return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
              };
              const buildLabel = () => {
                const elapsed = formatElapsed();
                const eta = formatEta();
                return eta
                  ? `${lastLabel} · elapsed ${elapsed} · eta ${eta}`
                  : `${lastLabel} · elapsed ${elapsed}`;
              };
              await withProgressTotals(
                {
                  label: "Indexing memory…",
                  total: 0,
                  fallback: opts.verbose ? "line" : undefined,
                },
                async (update, progress) => {
                  const interval = setInterval(() => {
                    progress.setLabel(buildLabel());
                  }, 1000);
                  try {
                    await manager.sync({
                      reason: "cli",
                      force: opts.force,
                      progress: (syncUpdate) => {
                        if (syncUpdate.label) lastLabel = syncUpdate.label;
                        lastCompleted = syncUpdate.completed;
                        lastTotal = syncUpdate.total;
                        update({
                          completed: syncUpdate.completed,
                          total: syncUpdate.total,
                          label: buildLabel(),
                        });
                        progress.setLabel(buildLabel());
                      },
                    });
                  } finally {
                    clearInterval(interval);
                  }
                },
              );
              defaultRuntime.log(`Memory index updated (${agentId}).`);
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory index failed (${agentId}): ${message}`);
              process.exitCode = 1;
            }
          },
        });
      }
    });

  memory
    .command("search")
    .description("Search memory files")
    .argument("<query>", "Search query")
    .option("--agent <id>", "Agent id (default: default agent)")
    .option("--max-results <n>", "Max results", (value: string) => Number(value))
    .option("--min-score <n>", "Minimum score", (value: string) => Number(value))
    .option("--json", "Print JSON")
    .action(
      async (
        query: string,
        opts: MemoryCommandOptions & {
          maxResults?: number;
          minScore?: number;
        },
      ) => {
        const cfg = loadConfig();
        const agentId = resolveAgent(cfg, opts.agent);
        await withManager<MemoryManager>({
          getManager: () => getMemorySearchManager({ cfg, agentId }),
          onMissing: (error) => defaultRuntime.log(error ?? "Memory search disabled."),
          onCloseError: (err) =>
            defaultRuntime.error(`Memory manager close failed: ${formatErrorMessage(err)}`),
          close: (manager) => manager.close(),
          run: async (manager) => {
            let results: Awaited<ReturnType<typeof manager.search>>;
            try {
              results = await manager.search(query, {
                maxResults: opts.maxResults,
                minScore: opts.minScore,
              });
            } catch (err) {
              const message = formatErrorMessage(err);
              defaultRuntime.error(`Memory search failed: ${message}`);
              process.exitCode = 1;
              return;
            }
            if (opts.json) {
              defaultRuntime.log(JSON.stringify({ results }, null, 2));
              return;
            }
            if (results.length === 0) {
              defaultRuntime.log("No matches.");
              return;
            }
            const rich = isRich();
            const lines: string[] = [];
            for (const result of results) {
              lines.push(
                `${colorize(rich, theme.success, result.score.toFixed(3))} ${colorize(
                  rich,
                  theme.accent,
                  `${shortenHomePath(result.path)}:${result.startLine}-${result.endLine}`,
                )}`,
              );
              lines.push(colorize(rich, theme.muted, result.snippet));
              lines.push("");
            }
            defaultRuntime.log(lines.join("\n").trim());
          },
        });
      },
    );

  // Facts memory subcommands
  registerFactsCommands(memory);
}

// ============================================================================
// Facts Memory Commands
// ============================================================================

type FactsCleanupOptions = {
  dryRun?: boolean;
  maxAgeDays?: string;
  maxSizeMb?: string;
  pruneLowImportance?: boolean;
  minImportance?: string;
  truncateSummaries?: boolean;
  truncateSummariesDays?: string;
  vacuum?: boolean;
  json?: boolean;
  force?: boolean;
};

type FactsStatusOptions = {
  json?: boolean;
};

type FactsStatsOptions = {
  json?: boolean;
};

/** Status result for facts memory */
interface FactsStatusResult {
  enabled: boolean;
  extraction: {
    enabled: boolean;
    provider?: string;
    model?: string;
  };
  limits: {
    maxMessages: number;
    maxFacts: number;
    maxTokens: number;
    cooldownMs: number;
  };
  database: {
    path: string;
    sizeBytes: number;
    totalFacts: number;
    ftsAvailable: boolean;
  };
  error?: string;
}

/** Stats result for facts memory */
interface FactsStatsResult {
  database: {
    path: string;
    sizeBytes: number;
    totalMemories: number;
    oldMemories: number;
    lowImportanceMemories: number;
  };
  summaries: {
    daily: number;
    weekly: number;
  };
  extraction: {
    added: number;
    updated: number;
    deleted: number;
    skipped: number;
    avgLatencyMs: number;
    extractionCount: number;
  };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function registerFactsCommands(memory: Command) {
  const facts = memory
    .command("facts")
    .description("Facts memory management (SQLite-based conversation memory)")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/memory/facts", "docs.openclaw.ai/memory/facts")}\n`,
    );

  // status command
  facts
    .command("status")
    .description("Show facts memory operational status")
    .option("--json", "Output as JSON")
    .action(async (opts: FactsStatusOptions) => {
      const rich = isRich() && !opts.json;

      try {
        const cfg = loadConfig();
        const factsConfig = cfg.factsMemory ?? {};

        // Check if facts memory is enabled
        const enabled = factsConfig.enabled !== false;
        const extractionEnabled = enabled && factsConfig.extraction?.enabled !== false;

        // Default limits
        const limits = {
          maxMessages: factsConfig.limits?.maxMessages ?? 25,
          maxFacts: factsConfig.limits?.maxFacts ?? 50,
          maxTokens: factsConfig.limits?.maxTokens ?? 1500,
          cooldownMs: factsConfig.limits?.cooldownMs ?? 30000,
        };

        let result: FactsStatusResult;

        if (!enabled) {
          result = {
            enabled: false,
            extraction: { enabled: false },
            limits,
            database: {
              path: "",
              sizeBytes: 0,
              totalFacts: 0,
              ftsAvailable: false,
            },
          };
        } else {
          const manager = createFactsMemoryManager(factsConfig);
          const store = manager.getStore();
          const markdownPath = manager.getMarkdownPath();

          const stats = getCleanupStats(store, markdownPath);

          result = {
            enabled: true,
            extraction: {
              enabled: extractionEnabled,
              provider: factsConfig.extraction?.provider,
              model: factsConfig.extraction?.model,
            },
            limits,
            database: {
              path: store.getDbPath(),
              sizeBytes: stats.dbSizeBytes,
              totalFacts: stats.totalMemories,
              ftsAvailable: store.isFtsAvailable(),
            },
          };

          await manager.close();
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }

        // Pretty print
        defaultRuntime.log(colorize(rich, theme.heading, "Facts Memory Status"));
        defaultRuntime.log("");

        // Enabled status
        const enabledStatus = result.enabled
          ? colorize(rich, theme.success, "enabled")
          : colorize(rich, theme.warn, "disabled");
        defaultRuntime.log(`${colorize(rich, theme.muted, "Status:")} ${enabledStatus}`);

        if (!result.enabled) {
          defaultRuntime.log("");
          defaultRuntime.log(
            colorize(rich, theme.muted, "Set factsMemory.enabled=true in config to enable."),
          );
          return;
        }

        // Extraction status
        const extractionStatus = result.extraction.enabled
          ? colorize(rich, theme.success, "enabled")
          : colorize(rich, theme.muted, "disabled");
        defaultRuntime.log(`${colorize(rich, theme.muted, "Extraction:")} ${extractionStatus}`);

        if (result.extraction.enabled && result.extraction.provider && result.extraction.model) {
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Provider/Model:")} ${result.extraction.provider}/${result.extraction.model}`,
          );
        }

        defaultRuntime.log("");
        defaultRuntime.log(colorize(rich, theme.heading, "Database"));
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Path:")} ${shortenHomePath(result.database.path)}`,
        );
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Size:")} ${formatBytes(result.database.sizeBytes)}`,
        );
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Total facts:")} ${result.database.totalFacts}`,
        );
        const ftsStatus = result.database.ftsAvailable
          ? colorize(rich, theme.success, "available")
          : colorize(rich, theme.warn, "unavailable");
        defaultRuntime.log(`${colorize(rich, theme.muted, "FTS:")} ${ftsStatus}`);

        defaultRuntime.log("");
        defaultRuntime.log(colorize(rich, theme.heading, "Guardrails"));
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Max messages:")} ${result.limits.maxMessages}`,
        );
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Max facts:")} ${result.limits.maxFacts}`,
        );
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Max tokens:")} ${result.limits.maxTokens}`,
        );
        defaultRuntime.log(
          `${colorize(rich, theme.muted, "Cooldown:")} ${result.limits.cooldownMs}ms`,
        );
      } catch (err) {
        const message = formatErrorMessage(err);
        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                enabled: false,
                extraction: { enabled: false },
                limits: { maxMessages: 25, maxFacts: 50, maxTokens: 1500, cooldownMs: 30000 },
                database: { path: "", sizeBytes: 0, totalFacts: 0, ftsAvailable: false },
                error: message,
              },
              null,
              2,
            ),
          );
        } else {
          defaultRuntime.error(`Facts status failed: ${message}`);
        }
        process.exitCode = 1;
      }
    });

  // cleanup command
  facts
    .command("cleanup")
    .description("Clean up old facts memories based on retention policy")
    .option("-n, --dry-run", "Show what would be deleted without deleting")
    .option("--max-age-days <days>", "Maximum age in days for memories")
    .option("--max-size-mb <mb>", "Maximum database size in MB")
    .option("--prune-low-importance", "Prune memories with low importance")
    .option("--min-importance <value>", "Minimum importance threshold (0-1)")
    .option("--truncate-summaries", "Truncate old summary files")
    .option("--truncate-summaries-days <days>", "Days after which summaries are truncated")
    .option("--vacuum", "Vacuum database after cleanup to reclaim space")
    .option("--json", "Output as JSON")
    .option("-f, --force", "Skip confirmation prompts")
    .action(async (opts: FactsCleanupOptions) => {
      const rich = isRich() && !opts.json;

      try {
        const cfg = loadConfig();
        const factsConfig = cfg.factsMemory ?? {};

        // Create manager to get store and paths
        const manager = createFactsMemoryManager(factsConfig);
        const store = manager.getStore();
        const markdownPath = manager.getMarkdownPath();

        // Build cleanup options from CLI args
        const cleanupOpts = {
          dryRun: opts.dryRun ?? false,
          maxAgeDays: opts.maxAgeDays ? parseInt(opts.maxAgeDays, 10) : undefined,
          maxSizeMb: opts.maxSizeMb ? parseInt(opts.maxSizeMb, 10) : undefined,
          pruneLowImportance: opts.pruneLowImportance ?? false,
          minImportance: opts.minImportance ? parseFloat(opts.minImportance) : undefined,
          truncateSummaries: opts.truncateSummaries ?? false,
          truncateSummariesDays: opts.truncateSummariesDays
            ? parseInt(opts.truncateSummariesDays, 10)
            : undefined,
        };

        // In dry-run mode, show what would be deleted
        if (opts.dryRun) {
          const result = runCleanup(store, markdownPath, factsConfig, cleanupOpts);

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            defaultRuntime.log(colorize(rich, theme.heading, "Facts Memory Cleanup (dry-run)"));
            defaultRuntime.log("");
            defaultRuntime.log(
              `${colorize(rich, theme.muted, "Memories to delete:")} ${result.candidates?.length ?? 0}`,
            );
            defaultRuntime.log(
              `${colorize(rich, theme.muted, "Summaries to delete:")} ${result.summaryCandidates?.length ?? 0}`,
            );

            if (result.candidates && result.candidates.length > 0) {
              defaultRuntime.log("");
              defaultRuntime.log(colorize(rich, theme.muted, "Memory candidates:"));
              for (const mem of result.candidates.slice(0, 10)) {
                const age = Math.floor((Date.now() / 1000 - mem.createdAt) / 86400);
                defaultRuntime.log(
                  `  ${mem.id.slice(0, 8)}... ${mem.type} (${age}d old, importance=${mem.importance.toFixed(2)})`,
                );
              }
              if (result.candidates.length > 10) {
                defaultRuntime.log(
                  colorize(rich, theme.muted, `  ... and ${result.candidates.length - 10} more`),
                );
              }
            }

            if (result.summaryCandidates && result.summaryCandidates.length > 0) {
              defaultRuntime.log("");
              defaultRuntime.log(colorize(rich, theme.muted, "Summary file candidates:"));
              for (const file of result.summaryCandidates.slice(0, 5)) {
                defaultRuntime.log(`  ${shortenHomePath(file)}`);
              }
              if (result.summaryCandidates.length > 5) {
                defaultRuntime.log(
                  colorize(
                    rich,
                    theme.muted,
                    `  ... and ${result.summaryCandidates.length - 5} more`,
                  ),
                );
              }
            }
          }

          await manager.close();
          return;
        }

        // Show stats before cleanup
        const stats = getCleanupStats(store, markdownPath, cleanupOpts);

        if (!opts.json && !opts.force) {
          defaultRuntime.log(colorize(rich, theme.heading, "Facts Memory Cleanup"));
          defaultRuntime.log("");
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Database size:")} ${formatBytes(stats.dbSizeBytes)}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Total memories:")} ${stats.totalMemories}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Old memories:")} ${stats.oldMemories}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Low importance:")} ${stats.lowImportanceMemories}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Daily summaries:")} ${stats.dailySummaries}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Weekly summaries:")} ${stats.weeklySummaries}`,
          );
          defaultRuntime.log("");

          const confirmed = await promptYesNo("Proceed with cleanup? This cannot be undone.");
          if (!confirmed) {
            defaultRuntime.log(colorize(rich, theme.muted, "Cleanup cancelled."));
            await manager.close();
            return;
          }
        }

        // Run actual cleanup
        const result = runCleanup(store, markdownPath, factsConfig, cleanupOpts);

        // Vacuum if requested and cleanup succeeded
        if (opts.vacuum && result.success) {
          vacuumDatabase(store);
        }

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else {
          defaultRuntime.log("");
          if (result.success) {
            defaultRuntime.log(colorize(rich, theme.success, "✓ Cleanup completed"));
          } else {
            defaultRuntime.log(colorize(rich, theme.error, "✗ Cleanup failed"));
            if (result.error) {
              defaultRuntime.log(`${colorize(rich, theme.muted, "Error:")} ${result.error}`);
            }
          }
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Memories deleted:")} ${result.memoriesDeleted}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Summaries deleted:")} ${result.summariesTruncated}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Space freed:")} ${formatBytes(result.bytesFreed)}`,
          );
          if (opts.vacuum) {
            defaultRuntime.log(
              `${colorize(rich, theme.muted, "Database vacuumed:")} ${colorize(rich, theme.success, "yes")}`,
            );
          }
        }

        await manager.close();
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Facts cleanup failed: ${message}`);
        process.exitCode = 1;
      }
    });

  // stats command
  facts
    .command("stats")
    .description("Show facts memory statistics and extraction telemetry")
    .option("--json", "Output as JSON")
    .action(async (opts: FactsStatsOptions) => {
      const rich = isRich() && !opts.json;

      try {
        const cfg = loadConfig();
        const factsConfig = cfg.factsMemory ?? {};

        // Check if facts memory is enabled
        if (factsConfig.enabled === false) {
          const result: FactsStatsResult = {
            database: {
              path: "",
              sizeBytes: 0,
              totalMemories: 0,
              oldMemories: 0,
              lowImportanceMemories: 0,
            },
            summaries: { daily: 0, weekly: 0 },
            extraction: {
              added: 0,
              updated: 0,
              deleted: 0,
              skipped: 0,
              avgLatencyMs: 0,
              extractionCount: 0,
            },
          };
          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            defaultRuntime.log(colorize(rich, theme.muted, "Facts memory is disabled."));
          }
          return;
        }

        const manager = createFactsMemoryManager(factsConfig);
        const store = manager.getStore();
        const markdownPath = manager.getMarkdownPath();

        const stats = getCleanupStats(store, markdownPath);
        const telemetry = manager.getTelemetry();
        const avgLatencyMs =
          telemetry.extractionCount > 0
            ? Math.round(telemetry.totalLatencyMs / telemetry.extractionCount)
            : 0;

        const result: FactsStatsResult = {
          database: {
            path: store.getDbPath(),
            sizeBytes: stats.dbSizeBytes,
            totalMemories: stats.totalMemories,
            oldMemories: stats.oldMemories,
            lowImportanceMemories: stats.lowImportanceMemories,
          },
          summaries: {
            daily: stats.dailySummaries,
            weekly: stats.weeklySummaries,
          },
          extraction: {
            added: telemetry.added,
            updated: telemetry.updated,
            deleted: telemetry.deleted,
            skipped: telemetry.skipped,
            avgLatencyMs,
            extractionCount: telemetry.extractionCount,
          },
        };

        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
        } else {
          defaultRuntime.log(colorize(rich, theme.heading, "Facts Memory Statistics"));
          defaultRuntime.log("");
          defaultRuntime.log(colorize(rich, theme.heading, "Database"));
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Path:")} ${shortenHomePath(store.getDbPath())}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Size:")} ${formatBytes(stats.dbSizeBytes)}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Total memories:")} ${stats.totalMemories}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Old memories (>90d):")} ${stats.oldMemories}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Low importance (<0.2):")} ${stats.lowImportanceMemories}`,
          );
          defaultRuntime.log("");
          defaultRuntime.log(colorize(rich, theme.heading, "Summaries"));
          defaultRuntime.log(`${colorize(rich, theme.muted, "Daily:")} ${stats.dailySummaries}`);
          defaultRuntime.log(`${colorize(rich, theme.muted, "Weekly:")} ${stats.weeklySummaries}`);
          defaultRuntime.log("");
          defaultRuntime.log(colorize(rich, theme.heading, "Extraction (current session)"));
          defaultRuntime.log(`${colorize(rich, theme.muted, "Added:")} ${telemetry.added}`);
          defaultRuntime.log(`${colorize(rich, theme.muted, "Updated:")} ${telemetry.updated}`);
          defaultRuntime.log(`${colorize(rich, theme.muted, "Deleted:")} ${telemetry.deleted}`);
          defaultRuntime.log(`${colorize(rich, theme.muted, "Skipped:")} ${telemetry.skipped}`);
          defaultRuntime.log(`${colorize(rich, theme.muted, "Avg latency:")} ${avgLatencyMs}ms`);
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Extractions:")} ${telemetry.extractionCount}`,
          );
        }

        await manager.close();
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Facts stats failed: ${message}`);
        process.exitCode = 1;
      }
    });

  // repair command
  facts
    .command("repair")
    .description("Diagnose and repair the facts memory database")
    .option("--check", "Run integrity check")
    .option("--reindex", "Rebuild FTS index")
    .option("--vacuum", "Vacuum database to reclaim space")
    .option("--json", "Output as JSON")
    .action(
      async (opts: { check?: boolean; reindex?: boolean; vacuum?: boolean; json?: boolean }) => {
        const rich = isRich() && !opts.json;

        // Default to check if no options specified
        const hasOption = opts.check || opts.reindex || opts.vacuum;
        const repairOpts: RepairOptions = {
          check: opts.check || !hasOption,
          reindex: opts.reindex,
          vacuum: opts.vacuum,
        };

        try {
          const cfg = loadConfig();
          const factsConfig = cfg.factsMemory ?? {};
          const manager = createFactsMemoryManager(factsConfig);
          const store = manager.getStore();

          const result = runRepair(store, repairOpts);

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            defaultRuntime.log(colorize(rich, theme.heading, "Facts Memory Repair"));
            defaultRuntime.log("");

            if (result.integrityCheck) {
              const status = result.integrityCheck.ok
                ? colorize(rich, theme.success, "ok")
                : colorize(rich, theme.error, "failed");
              defaultRuntime.log(`${colorize(rich, theme.muted, "Integrity check:")} ${status}`);
              if (!result.integrityCheck.ok) {
                for (const msg of result.integrityCheck.messages) {
                  defaultRuntime.log(`  ${colorize(rich, theme.warn, msg)}`);
                }
              }
            }

            if (result.ftsReindex) {
              const status = result.ftsReindex.success
                ? colorize(rich, theme.success, `${result.ftsReindex.rowsReindexed} rows`)
                : colorize(rich, theme.error, "failed");
              defaultRuntime.log(`${colorize(rich, theme.muted, "FTS reindex:")} ${status}`);
              if (result.ftsReindex.error) {
                defaultRuntime.log(`  ${colorize(rich, theme.warn, result.ftsReindex.error)}`);
              }
            }

            if (result.vacuumed !== undefined) {
              const status = result.vacuumed
                ? colorize(rich, theme.success, "done")
                : colorize(rich, theme.error, "failed");
              defaultRuntime.log(`${colorize(rich, theme.muted, "Vacuum:")} ${status}`);
            }

            defaultRuntime.log("");
            if (result.success) {
              defaultRuntime.log(colorize(rich, theme.success, "Repair completed successfully."));
            } else {
              defaultRuntime.log(colorize(rich, theme.error, `Repair failed: ${result.error}`));
              process.exitCode = 1;
            }
          }

          await manager.close();
        } catch (err) {
          const message = formatErrorMessage(err);
          defaultRuntime.error(`Facts repair failed: ${message}`);
          process.exitCode = 1;
        }
      },
    );

  // export command
  facts
    .command("export")
    .description("Export facts memory to JSONL file")
    .requiredOption("--out <path>", "Output file path")
    .option("--redact", "Redact sensitive data (emails, phones, API keys, etc.)")
    .option(
      "--exclude-types <types>",
      "Comma-separated memory types to exclude (fact,preference,decision,event,todo)",
    )
    .option("--role <role>", "Role for access control (admin, operator, analyst, guest)")
    .option("--json", "Output result as JSON")
    .action(
      async (opts: {
        out: string;
        redact?: boolean;
        excludeTypes?: string;
        role?: string;
        json?: boolean;
      }) => {
        const rich = isRich() && !opts.json;

        try {
          const cfg = loadConfig();
          const factsConfig = cfg.factsMemory ?? {};
          const accessConfig = factsConfig.access;

          // Determine effective role
          let effectiveRole: AccessRole = "operator";
          if (opts.role) {
            if (!isValidRole(opts.role)) {
              defaultRuntime.error(
                `Invalid role: ${opts.role}. Valid roles: ${getAvailableRoles().join(", ")}`,
              );
              process.exitCode = 1;
              return;
            }
            effectiveRole = opts.role as AccessRole;
          } else if (accessConfig?.enabled && accessConfig.defaultRole) {
            effectiveRole = accessConfig.defaultRole;
          }

          // Check role permissions if access control is enabled
          const roleConfig = getRoleConfig(effectiveRole, accessConfig);
          if (accessConfig?.enabled) {
            // Check if role can export
            if (!roleConfig.canExport) {
              defaultRuntime.error(`Role '${effectiveRole}' is not allowed to export data.`);
              process.exitCode = 1;
              return;
            }
          }

          // Force redaction if role can't see unredacted (unless role is admin)
          let forceRedact = false;
          if (accessConfig?.enabled && !roleConfig.canSeeUnredacted && !opts.redact) {
            forceRedact = true;
          }

          // Parse and validate exclude-types
          const validTypes = ["fact", "preference", "decision", "event", "todo"] as const;
          type MemoryTypeLocal = (typeof validTypes)[number];
          let excludeTypes: MemoryTypeLocal[] | undefined;

          if (opts.excludeTypes) {
            const types = opts.excludeTypes.split(",").map((t) => t.trim().toLowerCase());
            const invalid = types.filter((t) => !validTypes.includes(t as MemoryTypeLocal));
            if (invalid.length > 0) {
              defaultRuntime.error(
                `Invalid types: ${invalid.join(", ")}. Valid types: ${validTypes.join(", ")}`,
              );
              process.exitCode = 1;
              return;
            }
            excludeTypes = types as MemoryTypeLocal[];
          }

          const manager = createFactsMemoryManager(factsConfig);
          const store = manager.getStore();

          const exportOptions: ExportOptions = {
            redact: opts.redact || forceRedact,
            excludeTypes,
            patterns: DEFAULT_REDACTION_PATTERNS,
          };

          const result = exportToJsonl(store, opts.out, exportOptions);

          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                { ...result, role: effectiveRole, forceRedacted: forceRedact },
                null,
                2,
              ),
            );
          } else {
            if (result.success) {
              defaultRuntime.log(colorize(rich, theme.success, "Export completed."));
              if (accessConfig?.enabled) {
                defaultRuntime.log(`${colorize(rich, theme.muted, "Role:")} ${effectiveRole}`);
              }
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Memories:")} ${result.memoriesExported}`,
              );
              if (result.memoriesExcluded && result.memoriesExcluded > 0) {
                defaultRuntime.log(
                  `${colorize(rich, theme.muted, "Excluded:")} ${result.memoriesExcluded}`,
                );
              }
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Blocks:")} ${result.blocksExported}`,
              );
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Summaries:")} ${result.summariesExported}`,
              );
              if (result.redactionApplied) {
                const redactNote = forceRedact ? " (required by role)" : "";
                defaultRuntime.log(colorize(rich, theme.info, `Redaction: applied${redactNote}`));
              }
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Output:")} ${shortenHomePath(result.outputPath)}`,
              );
            } else {
              defaultRuntime.log(colorize(rich, theme.error, `Export failed: ${result.error}`));
              process.exitCode = 1;
            }
          }

          await manager.close();
        } catch (err) {
          const message = formatErrorMessage(err);
          defaultRuntime.error(`Facts export failed: ${message}`);
          process.exitCode = 1;
        }
      },
    );

  // import command
  facts
    .command("import")
    .description("Import facts memory from JSONL file")
    .requiredOption("--in <path>", "Input file path")
    .option("--merge", "Merge with existing data (default)")
    .option("--replace", "Replace existing data")
    .option("--json", "Output result as JSON")
    .option("-f, --force", "Skip confirmation for replace mode")
    .action(
      async (opts: {
        in: string;
        merge?: boolean;
        replace?: boolean;
        json?: boolean;
        force?: boolean;
      }) => {
        const rich = isRich() && !opts.json;

        const mode: ImportOptions["mode"] = opts.replace ? "replace" : "merge";

        // Confirm replace mode
        if (mode === "replace" && !opts.force && !opts.json) {
          const confirmed = await promptYesNo(
            "Replace mode will delete all existing facts. Continue?",
          );
          if (!confirmed) {
            defaultRuntime.log(colorize(rich, theme.muted, "Import cancelled."));
            return;
          }
        }

        try {
          const cfg = loadConfig();
          const factsConfig = cfg.factsMemory ?? {};
          const manager = createFactsMemoryManager(factsConfig);
          const store = manager.getStore();

          const result = importFromJsonl(store, opts.in, { mode });

          if (opts.json) {
            defaultRuntime.log(JSON.stringify(result, null, 2));
          } else {
            if (result.success) {
              defaultRuntime.log(colorize(rich, theme.success, `Import completed (${mode} mode).`));
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Memories imported:")} ${result.memoriesImported}`,
              );
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Memories skipped:")} ${result.memoriesSkipped}`,
              );
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Blocks imported:")} ${result.blocksImported}`,
              );
              defaultRuntime.log(
                `${colorize(rich, theme.muted, "Summaries imported:")} ${result.summariesImported}`,
              );
            } else {
              defaultRuntime.log(colorize(rich, theme.error, `Import failed: ${result.error}`));
              process.exitCode = 1;
            }
          }

          await manager.close();
        } catch (err) {
          const message = formatErrorMessage(err);
          defaultRuntime.error(`Facts import failed: ${message}`);
          process.exitCode = 1;
        }
      },
    );

  // top command
  facts
    .command("top")
    .description("Show top facts by importance and recency")
    .option("--limit <n>", "Number of facts to show", "10")
    .option("--type <type>", "Filter by type (fact, preference, decision, event, todo)")
    .option("--role <role>", "Filter by access role (admin, operator, analyst, guest)")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit: string; type?: string; role?: string; json?: boolean }) => {
      const rich = isRich() && !opts.json;
      const limit = parseInt(opts.limit, 10) || 10;
      const validTypes = ["fact", "preference", "decision", "event", "todo"];
      const typeFilter = opts.type && validTypes.includes(opts.type) ? opts.type : undefined;

      // Validate and parse role
      let role: AccessRole | undefined;
      if (opts.role) {
        if (!isValidRole(opts.role)) {
          defaultRuntime.error(
            `Invalid role: ${opts.role}. Valid roles: ${getAvailableRoles().join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        role = opts.role as AccessRole;
      }

      try {
        const cfg = loadConfig();
        const factsConfig = cfg.factsMemory ?? {};

        if (factsConfig.enabled === false) {
          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                { facts: [], count: 0, filter: typeFilter, role: role ?? null },
                null,
                2,
              ),
            );
          } else {
            defaultRuntime.log(colorize(rich, theme.muted, "Facts memory is disabled."));
          }
          return;
        }

        // Validate type option
        if (opts.type && !validTypes.includes(opts.type)) {
          defaultRuntime.error(`Invalid type: ${opts.type}. Valid types: ${validTypes.join(", ")}`);
          process.exitCode = 1;
          return;
        }

        const manager = createFactsMemoryManager(factsConfig);
        const store = manager.getStore();

        // Get memories, optionally filtered by type
        const listOpts = typeFilter
          ? {
              limit: limit * 3,
              types: [typeFilter as "fact" | "preference" | "decision" | "event" | "todo"],
            }
          : { limit: limit * 2 };
        let memories = store.list(listOpts);

        // Apply role-based filtering
        let excluded = 0;
        if (role) {
          const original = memories;
          memories = filterByRole(memories, role);
          excluded = original.length - memories.length;
          // Log audit event
          const auditEvent = createAuditEvent(
            role,
            memories,
            original.filter((m) => !memories.includes(m)),
          );
          logAuditEvent(auditEvent);
        }

        const now = Math.floor(Date.now() / 1000);

        // Score = importance * recency_decay (decay = 1 - age_days/365)
        const scored = memories.map((m) => {
          const ageDays = Math.max(0, (now - m.createdAt) / 86400);
          const recencyDecay = Math.max(0.1, 1 - ageDays / 365);
          const score = m.importance * recencyDecay;
          return { memory: m, score };
        });

        // Sort by score and take top N
        scored.sort((a, b) => b.score - a.score);
        const topFacts = scored.slice(0, limit);

        if (opts.json) {
          const output = {
            facts: topFacts.map((f) => ({
              id: f.memory.id,
              type: f.memory.type,
              content: f.memory.content,
              importance: f.memory.importance,
              score: f.score,
              createdAt: f.memory.createdAt,
            })),
            count: topFacts.length,
            filter: typeFilter ?? null,
            role: role ?? null,
            excluded: excluded > 0 ? excluded : undefined,
          };
          defaultRuntime.log(JSON.stringify(output, null, 2));
        } else {
          const title = typeFilter
            ? `Top ${topFacts.length} ${typeFilter}s`
            : `Top ${topFacts.length} Facts`;
          defaultRuntime.log(colorize(rich, theme.heading, title));
          if (role) {
            defaultRuntime.log(
              `${colorize(rich, theme.muted, "Role:")} ${role}${excluded > 0 ? ` (${excluded} filtered)` : ""}`,
            );
          }
          defaultRuntime.log("");

          for (let i = 0; i < topFacts.length; i++) {
            const { memory, score } = topFacts[i];
            const snippet =
              memory.content.length > 60 ? memory.content.slice(0, 60) + "..." : memory.content;
            const date = new Date(memory.createdAt * 1000).toLocaleDateString();
            defaultRuntime.log(
              `${colorize(rich, theme.accent, `${i + 1}.`)} ${colorize(rich, theme.info, snippet)}`,
            );
            defaultRuntime.log(
              `   ${colorize(rich, theme.muted, `[${memory.type}] importance=${memory.importance.toFixed(2)} score=${score.toFixed(2)} ${date}`)}`,
            );
          }

          if (topFacts.length === 0) {
            const msg = typeFilter ? `No ${typeFilter}s stored yet.` : "No facts stored yet.";
            defaultRuntime.log(colorize(rich, theme.muted, msg));
          }
        }

        await manager.close();
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Facts top failed: ${message}`);
        process.exitCode = 1;
      }
    });

  // trace command (explainability)
  facts
    .command("trace")
    .description("Show retrieval trace for a query (explainability)")
    .argument("<query>", "Query to trace")
    .option("--limit <n>", "Maximum memories to retrieve", "10")
    .option("--role <role>", "Filter by access role (admin, operator, analyst, guest)")
    .option("--json", "Output as JSON")
    .action(async (query: string, opts: { limit: string; role?: string; json?: boolean }) => {
      const rich = isRich() && !opts.json;
      const limit = parseInt(opts.limit, 10) || 10;

      // Validate and parse role
      let role: AccessRole | undefined;
      if (opts.role) {
        if (!isValidRole(opts.role)) {
          defaultRuntime.error(
            `Invalid role: ${opts.role}. Valid roles: ${getAvailableRoles().join(", ")}`,
          );
          process.exitCode = 1;
          return;
        }
        role = opts.role as AccessRole;
      }

      try {
        const cfg = loadConfig();
        const factsConfig = cfg.factsMemory ?? {};

        if (factsConfig.enabled === false) {
          if (opts.json) {
            defaultRuntime.log(
              JSON.stringify(
                { context: "", reasons: [], query, memoriesIncluded: 0, role: role ?? null },
                null,
                2,
              ),
            );
          } else {
            defaultRuntime.log(colorize(rich, theme.muted, "Facts memory is disabled."));
          }
          return;
        }

        const manager = createFactsMemoryManager(factsConfig);
        const store = manager.getStore();

        const trace = getRelevantContextWithTrace(store, query, { maxResults: limit });

        // Apply role-based filtering to trace results
        let filteredReasons = trace.reasons;
        let excluded = 0;
        if (role) {
          // Filter reasons by type based on role permissions
          const roleAllowedTypes = getRoleAllowedTypes(role);
          filteredReasons = trace.reasons.filter((r) =>
            roleAllowedTypes.includes(
              r.type as "fact" | "preference" | "decision" | "event" | "todo",
            ),
          );
          excluded = trace.reasons.length - filteredReasons.length;

          // Log audit event
          const includedEntries = filteredReasons.map((r) => ({
            id: r.id,
            type: r.type as "fact" | "preference" | "decision" | "event" | "todo",
          }));
          const excludedEntries = trace.reasons
            .filter(
              (r) =>
                !roleAllowedTypes.includes(
                  r.type as "fact" | "preference" | "decision" | "event" | "todo",
                ),
            )
            .map((r) => ({
              id: r.id,
              type: r.type as "fact" | "preference" | "decision" | "event" | "todo",
            }));
          const auditEvent = createAuditEvent(
            role,
            includedEntries as unknown as import("../memory/facts/types.js").MemoryEntry[],
            excludedEntries as unknown as import("../memory/facts/types.js").MemoryEntry[],
            query,
          );
          logAuditEvent(auditEvent);
        }

        if (opts.json) {
          const output = {
            ...trace,
            reasons: filteredReasons,
            memoriesIncluded: filteredReasons.length,
            role: role ?? null,
            excluded: excluded > 0 ? excluded : undefined,
          };
          defaultRuntime.log(JSON.stringify(output, null, 2));
        } else {
          defaultRuntime.log(colorize(rich, theme.heading, "Retrieval Trace"));
          defaultRuntime.log(`${colorize(rich, theme.muted, "Query:")} ${query}`);
          if (role) {
            defaultRuntime.log(
              `${colorize(rich, theme.muted, "Role:")} ${role}${excluded > 0 ? ` (${excluded} filtered)` : ""}`,
            );
          }
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Timestamp:")} ${new Date(trace.timestamp).toISOString()}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Considered:")} ${trace.totalConsidered} memories`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Included:")} ${filteredReasons.length} memories`,
          );
          defaultRuntime.log("");

          if (filteredReasons.length === 0) {
            defaultRuntime.log(colorize(rich, theme.muted, "No relevant memories found."));
          } else {
            defaultRuntime.log(colorize(rich, theme.heading, "Reasons"));
            defaultRuntime.log("");

            for (let i = 0; i < filteredReasons.length; i++) {
              const reason = filteredReasons[i];
              const sourceColor =
                reason.source === "fts"
                  ? theme.success
                  : reason.source === "importance"
                    ? theme.accent
                    : theme.info;

              defaultRuntime.log(
                `${colorize(rich, theme.accent, `${i + 1}.`)} ${colorize(rich, sourceColor, `[${reason.source}]`)} ${colorize(rich, theme.muted, `score=${reason.score.toFixed(3)}`)}`,
              );
              defaultRuntime.log(`   ${colorize(rich, theme.info, reason.snippet)}`);
              defaultRuntime.log(
                `   ${colorize(rich, theme.muted, `id=${reason.id.slice(0, 8)}... type=${reason.type}`)}`,
              );

              // Show relevant metadata
              if (reason.metadata) {
                const meta: string[] = [];
                if (reason.metadata.importance !== undefined) {
                  meta.push(`importance=${(reason.metadata.importance as number).toFixed(2)}`);
                }
                if (reason.metadata.accessCount !== undefined) {
                  meta.push(`access=${reason.metadata.accessCount}`);
                }
                if (reason.metadata.ftsScore !== undefined) {
                  meta.push(`fts=${(reason.metadata.ftsScore as number).toFixed(3)}`);
                }
                if (meta.length > 0) {
                  defaultRuntime.log(`   ${colorize(rich, theme.muted, meta.join(" "))}`);
                }
              }
              defaultRuntime.log("");
            }
          }

          if (trace.context) {
            defaultRuntime.log(colorize(rich, theme.heading, "Generated Context"));
            defaultRuntime.log(colorize(rich, theme.muted, "─".repeat(40)));
            defaultRuntime.log(trace.context);
          }
        }

        await manager.close();
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Facts trace failed: ${message}`);
        process.exitCode = 1;
      }
    });

  // health command
  facts
    .command("health")
    .description("Show facts memory health status and thresholds")
    .option("--check", "Run a health check now")
    .option("--json", "Output as JSON")
    .action(async (opts: { check?: boolean; json?: boolean }) => {
      const rich = isRich() && !opts.json;

      try {
        const cfg = loadConfig();
        const factsConfig = cfg.factsMemory ?? {};

        if (factsConfig.enabled === false) {
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ enabled: false, status: "disabled" }, null, 2));
          } else {
            defaultRuntime.log(colorize(rich, theme.muted, "Facts memory is disabled."));
          }
          return;
        }

        const manager = createFactsMemoryManager(factsConfig);
        const store = manager.getStore();
        const markdownPath = manager.getMarkdownPath();

        // Optionally run a health check first
        if (opts.check) {
          const result = triggerHealthCheckNow(cfg);
          if (!result.success) {
            defaultRuntime.error(`Health check failed: ${result.error}`);
            process.exitCode = 1;
            await manager.close();
            return;
          }
        }

        const summary = getHealthSummary(store, markdownPath, factsConfig);

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                enabled: true,
                ...summary,
              },
              null,
              2,
            ),
          );
        } else {
          // Status header with color
          const statusColor =
            summary.status === "ok"
              ? theme.success
              : summary.status === "warning"
                ? theme.warn
                : theme.error;
          defaultRuntime.log(colorize(rich, theme.heading, "Facts Memory Health"));
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Status:")} ${colorize(rich, statusColor, summary.status.toUpperCase())}`,
          );
          defaultRuntime.log("");

          // Snapshot
          defaultRuntime.log(colorize(rich, theme.heading, "Current State"));
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Database size:")} ${summary.snapshot.dbSizeMb.toFixed(2)} MB`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Total memories:")} ${summary.snapshot.totalMemories}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Extraction errors:")} ${summary.snapshot.extractionErrors}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Last extraction:")} ${summary.snapshot.lastExtractionAt ?? "never"}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Last cleanup:")} ${summary.snapshot.lastCleanupAt ?? "never"}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "FTS available:")} ${summary.snapshot.ftsAvailable ? "yes" : "no"}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Daily summaries:")} ${summary.snapshot.dailySummaries}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Weekly summaries:")} ${summary.snapshot.weeklySummaries}`,
          );
          defaultRuntime.log("");

          // Thresholds
          defaultRuntime.log(colorize(rich, theme.heading, "Thresholds"));
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Max DB size:")} ${summary.thresholds.maxDbSizeMb} MB`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Max errors/day:")} ${summary.thresholds.maxErrorsPerDay}`,
          );
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Max stale days:")} ${summary.thresholds.maxStaleDays}`,
          );

          // Active alerts
          if (summary.activeAlerts.length > 0) {
            defaultRuntime.log("");
            defaultRuntime.log(colorize(rich, theme.heading, "Active Alerts"));
            for (const alert of summary.activeAlerts) {
              const alertColor = alert.severity === "critical" ? theme.error : theme.warn;
              defaultRuntime.log(
                `${colorize(rich, alertColor, `[${alert.severity.toUpperCase()}]`)} ${alert.message}`,
              );
            }
          }
        }

        await manager.close();
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Facts health failed: ${message}`);
        process.exitCode = 1;
      }
    });

  // alerts command
  facts
    .command("alerts")
    .description("Show recent facts memory alerts")
    .option("--limit <n>", "Number of alerts to show", "20")
    .option("--json", "Output as JSON")
    .action(async (opts: { limit: string; json?: boolean }) => {
      const rich = isRich() && !opts.json;
      const limit = parseInt(opts.limit, 10) || 20;

      try {
        const cfg = loadConfig();
        const factsConfig = cfg.factsMemory ?? {};

        if (factsConfig.enabled === false) {
          if (opts.json) {
            defaultRuntime.log(JSON.stringify({ enabled: false, alerts: [] }, null, 2));
          } else {
            defaultRuntime.log(colorize(rich, theme.muted, "Facts memory is disabled."));
          }
          return;
        }

        const alerts = getRecentAlerts(limit);

        if (opts.json) {
          defaultRuntime.log(
            JSON.stringify(
              {
                enabled: true,
                alerts,
                count: alerts.length,
              },
              null,
              2,
            ),
          );
        } else {
          defaultRuntime.log(colorize(rich, theme.heading, "Recent Alerts"));
          defaultRuntime.log("");

          if (alerts.length === 0) {
            defaultRuntime.log(colorize(rich, theme.muted, "No recent alerts."));
          } else {
            for (const alert of alerts) {
              const alertColor = alert.severity === "critical" ? theme.error : theme.warn;
              const date = new Date(alert.timestamp).toLocaleString();
              defaultRuntime.log(
                `${colorize(rich, alertColor, `[${alert.severity.toUpperCase()}]`)} ${colorize(rich, theme.muted, `[${alert.type}]`)} ${alert.message}`,
              );
              defaultRuntime.log(`  ${colorize(rich, theme.muted, date)}`);
            }
          }
        }
      } catch (err) {
        const message = formatErrorMessage(err);
        defaultRuntime.error(`Facts alerts failed: ${message}`);
        process.exitCode = 1;
      }
    });
}
