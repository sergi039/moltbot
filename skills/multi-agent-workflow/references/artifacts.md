# Workflow Artifacts

## Storage Location

All artifacts are stored in:
```
~/.clawdbot/workflows/<run-id>/
├── run.json              # Workflow state
├── events.jsonl          # Orchestrator events
├── approvals.jsonl       # Approval records
└── phases/
    ├── 01-planning/
    │   ├── artifacts/
    │   │   ├── plan.md
    │   │   └── tasks.json
    │   └── logs/
    ├── 02-execution/
    │   ├── artifacts/
    │   │   ├── tasks.json
    │   │   └── execution-report.json
    │   └── logs/
    └── 03-review/
        ├── artifacts/
        │   ├── review.json
        │   └── recommendations.json
        └── logs/
```

## Artifact Types

### plan.md

Implementation plan in markdown format.

```markdown
# Implementation Plan

## Overview
Brief description of the approach.

## Tasks
1. Task 1 - Description
2. Task 2 - Description

## Dependencies
- Task 2 depends on Task 1

## Risks
- Identified risks and mitigations
```

### tasks.json

Structured task list following TaskList schema.

```json
{
  "version": "1.0",
  "projectName": "my-project",
  "createdAt": 1706700000000,
  "updatedAt": 1706700000000,
  "tasks": [
    {
      "id": "task-001",
      "title": "Add authentication middleware",
      "description": "Create JWT validation middleware",
      "type": "feature",
      "priority": 1,
      "complexity": 3,
      "status": "pending",
      "dependsOn": [],
      "acceptanceCriteria": [
        "Validates JWT tokens",
        "Returns 401 for invalid tokens"
      ],
      "targetFiles": ["src/middleware/auth.ts"]
    }
  ],
  "stats": {
    "total": 1,
    "pending": 1,
    "completed": 0,
    "failed": 0
  }
}
```

### execution-report.json

Summary of task execution.

```json
{
  "version": "1.0",
  "executedAt": 1706700000000,
  "tasks": [
    {
      "taskId": "task-001",
      "status": "completed",
      "filesModified": ["src/middleware/auth.ts"],
      "testsAdded": ["src/middleware/auth.test.ts"],
      "notes": "Implemented JWT validation"
    }
  ],
  "summary": {
    "total": 5,
    "completed": 5,
    "failed": 0
  }
}
```

### review.json

Code review results.

```json
{
  "version": "1.0",
  "reviewedAt": 1706700000000,
  "reviewer": "codex",
  "overallScore": 85,
  "approved": true,
  "scores": {
    "architecture": 80,
    "codeQuality": 90,
    "testCoverage": 85,
    "security": 85,
    "documentation": 80
  },
  "issues": [
    {
      "id": "issue-001",
      "severity": "medium",
      "category": "security",
      "file": "src/auth.ts",
      "line": 42,
      "description": "Token expiry not validated",
      "suggestion": "Add expiry check before processing"
    }
  ],
  "summary": "Good implementation with minor security improvements needed."
}
```

### recommendations.json

Improvement suggestions for future work.

```json
{
  "version": "1.0",
  "recommendations": [
    {
      "id": "rec-001",
      "priority": "should",
      "description": "Add rate limiting to auth endpoints",
      "rationale": "Prevent brute force attacks"
    }
  ]
}
```

## Accessing Artifacts

```bash
# View plan
cat ~/.clawdbot/workflows/<run-id>/phases/01-planning/artifacts/plan.md

# View tasks
cat ~/.clawdbot/workflows/<run-id>/phases/01-planning/artifacts/tasks.json | jq

# View review
cat ~/.clawdbot/workflows/<run-id>/phases/03-review/artifacts/review.json | jq
```

## Artifact Retention

Configured via `workflows.retention`:
- `artifactRetentionDays`: 30 (default)
- `logRetentionDays`: 14 (default)
- `failedLogRetentionDays`: 30 (default)
