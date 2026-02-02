# Policy & Approvals

## Overview

Live mode workflows enforce security policies to protect against unintended operations. The policy engine evaluates each action and can:
- **Allow** - Action proceeds immediately
- **Deny** - Action is blocked
- **Prompt** - User approval required

## Policy Structure

```json
{
  "version": "1.0",
  "pathScope": {
    "workspaceRoot": "/path/to/project",
    "allowedPaths": ["/path/to/project/**"],
    "blockedPaths": ["**/node_modules/**", "**/.git/**"]
  },
  "rules": [
    {
      "id": "allow-npm-test",
      "name": "Allow npm test",
      "actions": ["bash_execute"],
      "commandPatterns": ["^npm test"],
      "decision": "allow",
      "priority": 100,
      "enabled": true
    }
  ],
  "defaultDecision": "prompt",
  "requireApprovalForDestructive": true,
  "destructiveActions": ["file_delete", "bash_execute"]
}
```

## Action Types

| Action | Description | Example |
|--------|-------------|---------|
| `file_read` | Read file contents | `cat src/index.ts` |
| `file_write` | Write/modify files | `echo > file.ts` |
| `file_delete` | Delete files | `rm -rf dist/` |
| `bash_execute` | Run shell commands | `npm install` |
| `network_request` | HTTP requests | `curl api.example.com` |
| `agent_spawn` | Spawn sub-agent | Starting new agent |

## Default Blocked Patterns

These commands are blocked by default:
- `rm -rf /` - Destructive root delete
- `curl | bash` - Remote code execution
- `chmod 777` - Insecure permissions
- `sudo *` - Privilege escalation

## Approval Flow

When an action requires approval:

1. **Prompt Displayed**
   ```
   ┌─────────────────────────────────────┐
   │  Approval Required                  │
   │                                     │
   │  Action: bash_execute               │
   │  Command: npm run build             │
   │  Risk: Medium                       │
   │                                     │
   │  [Approve Once] [Approve & Remember]│
   │  [Deny] [Deny & Block]              │
   └─────────────────────────────────────┘
   ```

2. **User Options**
   - **Approve Once** - Allow this specific action
   - **Approve & Remember** - Allow for this workflow run
   - **Deny** - Block this action
   - **Deny & Block** - Block pattern for this run

3. **Timeout**
   - Default: 60 seconds
   - Configurable via `MOLTBOT_SMOKE_TIMEOUT`
   - Timeout = Deny

## Approval Records

Approvals are logged to `approvals.jsonl`:

```json
{
  "id": "apr-001",
  "timestamp": 1706700000000,
  "runId": "wf-abc123",
  "phaseId": "execution",
  "actionType": "bash_execute",
  "command": "npm run build",
  "decision": "approved",
  "remember": true,
  "respondedAt": 1706700005000
}
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `MOLTBOT_SMOKE_TIMEOUT` | Approval timeout (ms) | 60000 |

### Config File

`~/.openclaw/openclaw.json`:
```json
{
  "workflows": {
    "policy": {
      "approvalTimeoutMs": 60000,
      "defaultDecision": "prompt",
      "requireApprovalForDestructive": true
    }
  }
}
```

## Viewing Approvals

```bash
# View approval log
moltbot workflow logs <run-id> --type approval

# Raw JSONL
cat ~/.clawdbot/workflows/<run-id>/approvals.jsonl
```

## Security Modes

### Sandboxed (Default)
- Filesystem restricted to workspace
- Network access controlled
- Sensitive operations require approval

### Elevated
- Broader filesystem access
- Requires explicit `--elevated` flag
- Still respects blocked patterns
