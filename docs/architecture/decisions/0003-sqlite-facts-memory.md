# ADR-0003: SQLite for Facts Memory

- **Status:** accepted
- **Date:** 2024-06-01
- **Authors:** OpenClaw Team

## Context

OpenClaw needs a persistent memory system for storing and retrieving facts about users, preferences, and context. Requirements:

1. Fast key-value and full-text search
2. Persistence across restarts
3. Local-first (no external dependencies)
4. Support for vector similarity search (semantic memory)
5. Transactional consistency
6. Easy backup and recovery

## Decision

Use SQLite as the storage backend for Facts Memory with two databases:

1. **facts.db** - Structured facts with full-text search (FTS5)
2. **main.sqlite** - Vector embeddings for semantic search

### Schema (facts.db)

```sql
CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT DEFAULT 'global',
  created_at INTEGER,
  updated_at INTEGER,
  source TEXT
);

CREATE VIRTUAL TABLE facts_fts USING fts5(key, value, content=facts);
```

### Schema (main.sqlite)

```sql
CREATE TABLE embeddings (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  embedding BLOB NOT NULL,
  metadata TEXT,
  created_at INTEGER
);
```

Vector search uses sqlite-vss extension when available, with fallback to brute-force cosine similarity.

### Location

```
~/.openclaw/memory/
├── facts.db       # Facts with FTS5
└── main.sqlite    # Vector embeddings
```

## Consequences

### Positive

- **Zero external dependencies**: No Redis, PostgreSQL, or vector DB to manage
- **Portable**: Single file, easy to backup/restore
- **Fast**: SQLite is highly optimized for embedded use
- **Transactional**: ACID guarantees for data consistency
- **FTS5**: Built-in full-text search, no Elasticsearch needed
- **WAL mode**: Good concurrent read performance

### Negative

- **Single writer**: Write contention possible under high load
- **Vector search limitations**: sqlite-vss not as feature-rich as pgvector
- **No replication**: Local-only, manual backup required
- **Embedding size**: Can grow large with many documents

### Neutral

- Embeddings generated via OpenAI API (configurable batch mode)
- Memory indexing runs as background job
- Backup now includes memory databases

## Alternatives Considered

### PostgreSQL with pgvector

Rejected because:
- External dependency (server process)
- Overkill for personal assistant use case
- Complicates installation and deployment

### Redis

Rejected because:
- No built-in vector search (requires Redis Stack)
- Persistence not as robust as SQLite
- Memory-bound (expensive for large datasets)

### Pinecone/Weaviate/Milvus

Rejected because:
- External service or heavy local process
- API costs (Pinecone)
- Complexity for single-user deployment

### Plain JSON Files

Rejected because:
- No efficient full-text search
- No transactional safety
- Performance degrades with size

## References

- [SQLite Documentation](https://sqlite.org/docs.html)
- [FTS5 Extension](https://sqlite.org/fts5.html)
- [sqlite-vss](https://github.com/asg017/sqlite-vss)
- [Memory Configuration](/docs/configuration#memory)
