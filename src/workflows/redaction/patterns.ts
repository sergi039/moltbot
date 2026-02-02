/**
 * Redaction Patterns
 *
 * Regex patterns for identifying sensitive information in logs and artifacts.
 */

// ============================================================================
// Pattern Types
// ============================================================================

/**
 * A redaction pattern with metadata.
 */
export interface RedactionPattern {
  /** Pattern identifier */
  id: string;

  /** Human-readable name */
  name: string;

  /** The regex pattern */
  pattern: RegExp;

  /** Replacement text (can use $1, $2 etc for groups) */
  replacement: string;

  /** Category for reporting */
  category: RedactionCategory;

  /** Whether this pattern is enabled by default */
  enabled: boolean;
}

/**
 * Categories of redacted content.
 */
export type RedactionCategory =
  | "api_key"
  | "token"
  | "secret"
  | "password"
  | "jwt"
  | "oauth"
  | "ssh_key"
  | "private_key"
  | "credential"
  | "url_auth";

// ============================================================================
// API Key Patterns
// ============================================================================

/**
 * OpenAI API key pattern (sk-...)
 */
export const OPENAI_API_KEY: RedactionPattern = {
  id: "openai_api_key",
  name: "OpenAI API Key",
  pattern: /\bsk-[a-zA-Z0-9]{20,}[a-zA-Z0-9_-]*\b/g,
  replacement: "[REDACTED:OPENAI_KEY]",
  category: "api_key",
  enabled: true,
};

/**
 * Anthropic API key pattern (sk-ant-...)
 */
export const ANTHROPIC_API_KEY: RedactionPattern = {
  id: "anthropic_api_key",
  name: "Anthropic API Key",
  pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}\b/g,
  replacement: "[REDACTED:ANTHROPIC_KEY]",
  category: "api_key",
  enabled: true,
};

/**
 * GitHub Personal Access Token (ghp_..., gho_..., ghu_..., ghs_..., ghr_...)
 */
export const GITHUB_PAT: RedactionPattern = {
  id: "github_pat",
  name: "GitHub Personal Access Token",
  pattern: /\b(ghp|gho|ghu|ghs|ghr)_[a-zA-Z0-9]{36,}\b/g,
  replacement: "[REDACTED:GITHUB_PAT]",
  category: "token",
  enabled: true,
};

/**
 * GitHub OAuth token
 */
export const GITHUB_OAUTH: RedactionPattern = {
  id: "github_oauth",
  name: "GitHub OAuth Token",
  pattern: /\bghu_[a-zA-Z0-9]{36,}\b/g,
  replacement: "[REDACTED:GITHUB_OAUTH]",
  category: "oauth",
  enabled: true,
};

/**
 * Google API key (AIza...)
 */
export const GOOGLE_API_KEY: RedactionPattern = {
  id: "google_api_key",
  name: "Google API Key",
  pattern: /\bAIza[a-zA-Z0-9_-]{35}\b/g,
  replacement: "[REDACTED:GOOGLE_KEY]",
  category: "api_key",
  enabled: true,
};

/**
 * AWS Access Key ID
 */
export const AWS_ACCESS_KEY: RedactionPattern = {
  id: "aws_access_key",
  name: "AWS Access Key ID",
  pattern: /\b(AKIA|ABIA|ACCA|ASIA)[A-Z0-9]{16}\b/g,
  replacement: "[REDACTED:AWS_KEY]",
  category: "api_key",
  enabled: true,
};

/**
 * AWS Secret Access Key
 */
export const AWS_SECRET_KEY: RedactionPattern = {
  id: "aws_secret_key",
  name: "AWS Secret Access Key",
  pattern: /(?<=aws_secret_access_key\s*[=:]\s*)[a-zA-Z0-9/+]{40}(?=\s|$|")/g,
  replacement: "[REDACTED:AWS_SECRET]",
  category: "secret",
  enabled: true,
};

/**
 * Slack Bot Token (xoxb-...)
 */
export const SLACK_TOKEN: RedactionPattern = {
  id: "slack_token",
  name: "Slack Token",
  pattern: /\bxox[baprs]-[a-zA-Z0-9-]{10,}\b/g,
  replacement: "[REDACTED:SLACK_TOKEN]",
  category: "token",
  enabled: true,
};

/**
 * Discord Bot Token
 */
export const DISCORD_TOKEN: RedactionPattern = {
  id: "discord_token",
  name: "Discord Token",
  pattern: /\b[MN][a-zA-Z0-9]{23,}\.[a-zA-Z0-9_-]{6}\.[a-zA-Z0-9_-]{27,}\b/g,
  replacement: "[REDACTED:DISCORD_TOKEN]",
  category: "token",
  enabled: true,
};

/**
 * Telegram Bot Token
 */
export const TELEGRAM_TOKEN: RedactionPattern = {
  id: "telegram_token",
  name: "Telegram Bot Token",
  pattern: /\b[0-9]{8,10}:[a-zA-Z0-9_-]{35}\b/g,
  replacement: "[REDACTED:TELEGRAM_TOKEN]",
  category: "token",
  enabled: true,
};

// ============================================================================
// JWT and Bearer Patterns
// ============================================================================

/**
 * JWT token pattern
 */
export const JWT_TOKEN: RedactionPattern = {
  id: "jwt_token",
  name: "JWT Token",
  pattern: /\beyJ[a-zA-Z0-9_-]*\.eyJ[a-zA-Z0-9_-]*\.[a-zA-Z0-9_-]+\b/g,
  replacement: "[REDACTED:JWT]",
  category: "jwt",
  enabled: true,
};

/**
 * Bearer token in Authorization header
 */
export const BEARER_TOKEN: RedactionPattern = {
  id: "bearer_token",
  name: "Bearer Token",
  pattern: /\bBearer\s+[a-zA-Z0-9_.-]{20,}\b/gi,
  replacement: "Bearer [REDACTED:TOKEN]",
  category: "token",
  enabled: true,
};

// ============================================================================
// Environment Variable Patterns
// ============================================================================

/**
 * Generic API key in environment variable format
 */
export const ENV_API_KEY: RedactionPattern = {
  id: "env_api_key",
  name: "Environment API Key",
  pattern:
    /\b([A-Z_]*(?:API_KEY|APIKEY|API_SECRET)[A-Z_]*)\s*[=:]\s*["']?([a-zA-Z0-9_-]{16,})["']?/gi,
  replacement: "$1=[REDACTED:API_KEY]",
  category: "api_key",
  enabled: true,
};

/**
 * Generic token in environment variable format
 */
export const ENV_TOKEN: RedactionPattern = {
  id: "env_token",
  name: "Environment Token",
  pattern:
    /\b([A-Z_]*(?:TOKEN|ACCESS_TOKEN|AUTH_TOKEN)[A-Z_]*)\s*[=:]\s*["']?([a-zA-Z0-9_.-]{16,})["']?/gi,
  replacement: "$1=[REDACTED:TOKEN]",
  category: "token",
  enabled: true,
};

/**
 * Generic secret in environment variable format
 */
export const ENV_SECRET: RedactionPattern = {
  id: "env_secret",
  name: "Environment Secret",
  pattern:
    /\b([A-Z_]*(?:SECRET|SECRET_KEY|PRIVATE_KEY)[A-Z_]*)\s*[=:]\s*["']?([a-zA-Z0-9_/+=.-]{16,})["']?/gi,
  replacement: "$1=[REDACTED:SECRET]",
  category: "secret",
  enabled: true,
};

/**
 * Password in environment or config
 */
export const ENV_PASSWORD: RedactionPattern = {
  id: "env_password",
  name: "Environment Password",
  pattern: /\b([A-Z_]*(?:PASSWORD|PASSWD|PWD)[A-Z_]*)\s*[=:]\s*["']?([^\s"']{4,})["']?/gi,
  replacement: "$1=[REDACTED:PASSWORD]",
  category: "password",
  enabled: true,
};

// ============================================================================
// URL with Credentials
// ============================================================================

/**
 * URL with embedded credentials
 */
export const URL_CREDENTIALS: RedactionPattern = {
  id: "url_credentials",
  name: "URL with Credentials",
  pattern: /:\/\/([^:]+):([^@]+)@/g,
  replacement: "://[REDACTED:USER]:[REDACTED:PASS]@",
  category: "url_auth",
  enabled: true,
};

// ============================================================================
// SSH and Private Keys
// ============================================================================

/**
 * SSH private key header
 */
export const SSH_PRIVATE_KEY: RedactionPattern = {
  id: "ssh_private_key",
  name: "SSH Private Key",
  pattern:
    /-----BEGIN\s+(RSA|DSA|EC|OPENSSH)\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA|DSA|EC|OPENSSH)\s+PRIVATE\s+KEY-----/g,
  replacement: "[REDACTED:SSH_PRIVATE_KEY]",
  category: "ssh_key",
  enabled: true,
};

/**
 * Generic private key header
 */
export const PRIVATE_KEY: RedactionPattern = {
  id: "private_key",
  name: "Private Key",
  pattern: /-----BEGIN\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+PRIVATE\s+KEY-----/g,
  replacement: "[REDACTED:PRIVATE_KEY]",
  category: "private_key",
  enabled: true,
};

// ============================================================================
// Pattern Registry
// ============================================================================

/**
 * All redaction patterns in priority order.
 * More specific patterns should come before generic ones.
 */
export const DEFAULT_PATTERNS: RedactionPattern[] = [
  // Specific API keys first
  OPENAI_API_KEY,
  ANTHROPIC_API_KEY,
  GITHUB_PAT,
  GITHUB_OAUTH,
  GOOGLE_API_KEY,
  AWS_ACCESS_KEY,
  AWS_SECRET_KEY,
  SLACK_TOKEN,
  DISCORD_TOKEN,
  TELEGRAM_TOKEN,
  // JWT and Bearer
  JWT_TOKEN,
  BEARER_TOKEN,
  // Keys and certificates
  SSH_PRIVATE_KEY,
  PRIVATE_KEY,
  // URL credentials
  URL_CREDENTIALS,
  // Generic environment patterns (last)
  ENV_API_KEY,
  ENV_TOKEN,
  ENV_SECRET,
  ENV_PASSWORD,
];

/**
 * Get patterns by category.
 */
export function getPatternsByCategory(category: RedactionCategory): RedactionPattern[] {
  return DEFAULT_PATTERNS.filter((p) => p.category === category && p.enabled);
}

/**
 * Get all enabled patterns.
 */
export function getEnabledPatterns(): RedactionPattern[] {
  return DEFAULT_PATTERNS.filter((p) => p.enabled);
}
