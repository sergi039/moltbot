# Facts Memory System

The Facts Memory System provides persistent, structured memory for conversations. It extracts facts, preferences, decisions, and events from conversations and stores them in SQLite with optional semantic search via embeddings.

## Configuration

Enable in your config:

```json5
{
  factsMemory: {
    enabled: true,
    dbPath: "~/.openclaw/memory/facts.db",  // optional, default shown
    markdownPath: "~/.openclaw/memory",      // optional, for MEMORY.md sync
    batchSize: 10,                           // messages per extraction batch

    extraction: {
      enabled: true,
      provider: "anthropic",  // LLM provider for extraction
      model: "claude-sonnet-4-20250514"
    },

    scheduler: {
      dailyEnabled: true,
      dailyCron: "55 23 * * *",    // 11:55 PM daily
      weeklyEnabled: true,
      weeklyCron: "0 3 * * 0",     // 3 AM Sunday
      timezone: "America/New_York"
    },

    embeddings: {
      enabled: true,
      provider: "openai",
      model: "text-embedding-3-small",
      fallbackEnabled: true  // use stub embeddings if API unavailable
    }
  }
}
```

## Memory Types

| Type | Description |
|------|-------------|
| `fact` | Factual information about the user or context |
| `preference` | User preferences and settings |
| `decision` | Decisions made during conversations |
| `event` | Notable events or occurrences |
| `todo` | Tasks or action items |

## Memory Blocks

Self-editing blocks for structured context:

| Block | Purpose |
|-------|---------|
| `user_profile` | User identity, location, occupation |
| `persona` | Assistant behavior customization |
| `active_context` | Current working context |

## Degradation Modes

The system gracefully degrades when components are unavailable:

### Embeddings Unavailable
- Falls back to stub embeddings if `fallbackEnabled: true`
- Semantic search uses FTS (full-text search) only
- Logs: `memory.embedding.fallback: using stub embeddings`

### LLM Extraction Unavailable
- Skips extraction, no memories added
- Does not break reply pipeline
- Logs: `memory.extraction.llm_failed`

### Database Unavailable
- Operations fail gracefully
- Logs errors but continues reply flow

## Manual Operations

### Trigger Consolidation

```typescript
import { triggerConsolidationNow } from "openclaw/memory/facts";
import { loadConfig } from "openclaw/config";

const result = await triggerConsolidationNow(loadConfig());
console.log(result); // { success: true, summary: "..." }
```

### Export to Markdown

```typescript
import { exportToMemoryFile, openFactsMemoryStore } from "openclaw/memory/facts";

const store = openFactsMemoryStore("~/.openclaw/memory/facts.db");
const markdown = exportToMemoryFile(store);
// Write to file as needed
```

### Migrate Legacy MEMORY.md

```typescript
import { migrateMemoryDirectory, openFactsMemoryStore } from "openclaw/memory/facts";

const store = openFactsMemoryStore("~/.openclaw/memory/facts.db");
const result = migrateMemoryDirectory("~/path/to/project", store);
console.log(result); // { success: true, memoriesImported: 5 }
```

## Scheduler Jobs

The scheduler runs two consolidation jobs when enabled:

1. **Daily (11:55 PM)**: Summarizes the day's memories, prunes expired entries
2. **Weekly (Sunday 3 AM)**: Creates weekly summary from daily summaries

Jobs are started automatically when the gateway initializes if `factsMemory.scheduler` is configured.

## Monitoring

Watch for these log events:

| Event | Meaning |
|-------|---------|
| `memory.scheduler.start` | Scheduler started successfully |
| `memory.extraction.failed` | LLM extraction failed |
| `memory.extraction.llm_failed` | LLM returned error |
| `memory.embedding.failed` | Embedding API call failed |
| `memory.embedding.fallback` | Using stub embeddings |

## Storage

- **SQLite database**: `~/.openclaw/memory/facts.db`
- **Markdown sync**: `~/.openclaw/memory/MEMORY.md`
- **Daily summaries**: `~/.openclaw/memory/daily/YYYY-MM-DD.md`
- **Weekly summaries**: `~/.openclaw/memory/weekly/YYYY-WNN.md`
