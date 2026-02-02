---
summary: "E2E Workflow Testing: stub and live modes for workflow validation"
read_when:
  - Testing workflow mechanics (stub mode)
  - Testing live agent execution (live mode)
  - Validating approval/policy enforcement
  - Debugging workflow observability
---

# E2E Workflow Testing

This guide covers end-to-end validation of workflows in two modes:
- **Stub mode** (default): Tests workflow mechanics without API keys
- **Live mode**: Tests real agent execution with API keys

## Paths

| Type | Path |
|------|------|
| Config | `~/.openclaw/openclaw.json` |
| Workflow storage | `~/.clawdbot/workflows` (or `MOLTBOT_WORKFLOW_STORAGE`) |

## Quick Start

```bash
# Stub mode (no API keys required)
./scripts/e2e-live-smoke.sh

# Live mode (requires API keys)
./scripts/e2e-live-smoke.sh --live

# With options
./scripts/e2e-live-smoke.sh --live --repo /path/to/repo --task "Fix bug"

# Help
./scripts/e2e-live-smoke.sh --help
```

## Modes

### Stub Mode (Default)

Tests workflow mechanics without real agent execution:
- No API keys required
- Workflow starts/completes with stub runner
- Events and artifacts generated
- Fast, CI-safe

```bash
./scripts/e2e-live-smoke.sh
```

### Live Mode

Tests real agent execution with actual LLM calls:
- Requires `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
- Real agent runs with policy enforcement
- Approval prompts may trigger
- Uses `MOLTBOT_SMOKE_TIMEOUT` for approval timeout

```bash
ANTHROPIC_API_KEY=sk-... ./scripts/e2e-live-smoke.sh --live
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Anthropic API key (live mode) | - |
| `OPENAI_API_KEY` | OpenAI API key (live mode) | - |
| `MOLTBOT_SMOKE_TIMEOUT` | Approval timeout in ms (live mode) | 10000 |
| `MOLTBOT_WORKFLOW_STORAGE` | Workflow storage path | `~/.clawdbot/workflows` |

## Manual Test Scenarios

### 1. Smoke Workflow (Stub)

**Steps:**
```bash
moltbot workflow start \
  --type dev-cycle \
  --task "Add a simple comment" \
  --repo .
```

**Verify:**
```bash
moltbot workflow status <run-id>
ls ~/.clawdbot/workflows/<run-id>/
```

**Expected:**
- `run.json` with status
- `events.jsonl` with workflow events
- Artifacts in `artifacts/` directory

---

### 2. Smoke Workflow (Live)

**Setup:**
```bash
export ANTHROPIC_API_KEY=sk-...
# Or
export OPENAI_API_KEY=sk-...
```

**Steps:**
```bash
moltbot workflow start \
  --type dev-cycle \
  --task "Add a comment to README.md" \
  --repo . \
  --live
```

**Verify:**
```bash
moltbot workflow logs <run-id>
cat ~/.clawdbot/workflows/<run-id>/events.jsonl
```

**Expected:**
- `events.jsonl` contains `agent.start`, `agent.complete`, `policy.*`
- Artifacts: `plan.md`, `tasks.json`, `execution-report.json`, `review.json`

---

### 3. Approval Prompt (Approve Flow)

**Steps:**
1. Start live workflow with task requiring shell execution
2. When prompt appears, select **Approve once**
3. On next prompt, select **Approve and remember for this run**

```bash
moltbot workflow start \
  --type dev-cycle \
  --task "Run npm test" \
  --repo . \
  --live
```

**Verify:**
```bash
moltbot workflow logs <run-id> --type approval
cat ~/.clawdbot/workflows/<run-id>/approvals.jsonl
```

**Expected:**
- Prompt shows risk info
- `approvals.jsonl` contains records
- Remembered actions auto-approved

---

### 4. Deny Flow

**Steps:**
1. Start live workflow
2. On prompt, select **Deny**

**Expected:**
- Workflow status: `failed`
- Error contains "denied"
- `events.jsonl` contains `approval.denied`

---

### 5. Timeout Flow

**Setup:**
```bash
# Set short timeout
openclaw config set workflows.policy.approvalTimeoutMs 5000
```

**Steps:**
1. Start live workflow
2. Do NOT respond to prompt

**Expected:**
- Workflow fails with timeout
- `approvals.jsonl` contains timeout record

**Cleanup:**
```bash
openclaw config set workflows.policy.approvalTimeoutMs 60000
```

---

### 6. Policy Enforcement

Default policy blocks dangerous commands.

**Expected:**
- `rm -rf /`, `curl | bash` blocked
- `events.jsonl` contains `policy.deny`

---

### 7. Retention / Cleanup

```bash
# Preview cleanup
moltbot workflow cleanup --dry-run

# Cleanup logs only
moltbot workflow cleanup --logs-only

# Full cleanup
moltbot workflow cleanup
```

**Verify:**
```bash
moltbot workflow logs --global
```

---

## Observability

### Three Log Streams

```bash
# Observability events (workflow.start, agent.progress)
moltbot workflow logs <run-id>

# Orchestrator events (workflow:started, phase:completed)
moltbot workflow logs <run-id> --orchestrator

# Global events (cleanup, retention)
moltbot workflow logs --global
```

---

## Acceptance Criteria

- [ ] Stub workflow completes without API keys
- [ ] Live workflow completes with API keys
- [ ] Approval prompt blocks execution
- [ ] Approvals saved to JSONL
- [ ] Policy deny blocks dangerous actions
- [ ] Cleanup works (partial and full)
- [ ] All CLI log paths work

---

## Troubleshooting

### No API Keys (Live Mode)
```bash
openclaw models list
openclaw models auth
```

### Workflow Stuck
```bash
moltbot workflow cancel <run-id>
```

### Clean Slate
```bash
rm -rf ~/.clawdbot/workflows/*
```

---

## Related

- [Testing Guide](/testing) - Main testing documentation
- [Workflow CLI](/cli/workflow) - CLI reference
