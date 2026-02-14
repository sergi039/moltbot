/**
 * Secrets hygiene: detect literal tokens/secrets in config values.
 * Scans all string values in a parsed config object for known token patterns.
 * Env var references (${VAR}) are ignored — only literal values are flagged.
 */

// Patterns that identify literal tokens/secrets in string values.
const TOKEN_PATTERNS: RegExp[] = [
  // OpenAI
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  // GitHub PAT
  /\bghp_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  // Slack tokens
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/,
  /\bxapp-[A-Za-z0-9-]{10,}\b/,
  // Groq
  /\bgsk_[A-Za-z0-9_-]{10,}\b/,
  // Google AI
  /\bAIza[0-9A-Za-z\-_]{20,}\b/,
  // Perplexity
  /\bpplx-[A-Za-z0-9_-]{10,}\b/,
  // npm tokens
  /\bnpm_[A-Za-z0-9]{10,}\b/,
  // Telegram bot token (numeric:alphanum)
  /\b\d{8,}:[A-Za-z0-9_-]{20,}\b/,
  // Generic long hex/base64 secrets (40+ chars, common for API keys)
  /\b[A-Za-z0-9+/=_-]{40,}\b/,
];

// Env var reference pattern — these are safe (resolved at runtime).
const ENV_VAR_REF = /\$\{[^}]+\}/;

export type SecretsCheckResult = {
  /** Config paths where literal tokens were detected. */
  findings: Array<{
    path: string;
    preview: string;
  }>;
};

function isLikelyToken(value: string): boolean {
  // Skip env var references
  if (ENV_VAR_REF.test(value)) {
    return false;
  }
  // Skip short values (unlikely to be real tokens)
  if (value.length < 18) {
    return false;
  }
  // Skip values that look like paths, URLs without credentials, or simple strings
  if (value.startsWith("/") || value.startsWith("./") || value.startsWith("~")) {
    return false;
  }
  if (/^https?:\/\/[^:@]+$/.test(value)) {
    return false;
  }
  // Check against known token patterns
  return TOKEN_PATTERNS.some((pattern) => pattern.test(value));
}

function maskPreview(value: string): string {
  if (value.length <= 10) {
    return "***";
  }
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function scanObject(
  obj: unknown,
  currentPath: string,
  findings: SecretsCheckResult["findings"],
): void {
  if (typeof obj === "string") {
    if (isLikelyToken(obj)) {
      findings.push({ path: currentPath, preview: maskPreview(obj) });
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      scanObject(obj[i], `${currentPath}[${i}]`, findings);
    }
    return;
  }
  if (obj && typeof obj === "object") {
    for (const [key, value] of Object.entries(obj)) {
      // Skip known safe keys that commonly contain long strings
      if (key === "systemPrompt" || key === "instructions" || key === "template") {
        continue;
      }
      scanObject(value, currentPath ? `${currentPath}.${key}` : key, findings);
    }
  }
}

/**
 * Scan a parsed (pre-substitution) config object for literal tokens.
 * Returns findings with config paths and masked previews.
 */
export function checkConfigSecrets(parsed: unknown): SecretsCheckResult {
  const findings: SecretsCheckResult["findings"] = [];
  scanObject(parsed, "", findings);
  return { findings };
}
