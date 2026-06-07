import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export interface ConfluenceToolConfig {
  domain: string;
  email: string;
  apiToken: string;
  defaultPort: number;
}

export function loadDotEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(here, "../.env"),
    resolve(here, "../../.env"),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const contents = readFileSync(file, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = stripQuotes(rawValue.trim());
    }
  }
}

export function getConfig(): ConfluenceToolConfig {
  loadDotEnv();

  const domain = env("ATLASSIAN_DOMAIN") ?? env("CONFLUENCE_DOMAIN") ?? env("JIRA_DOMAIN");
  const email = env("ATLASSIAN_EMAIL") ?? env("CONFLUENCE_EMAIL") ?? env("JIRA_EMAIL");
  const apiToken = env("ATLASSIAN_API_TOKEN") ?? env("CONFLUENCE_API_TOKEN") ?? env("JIRA_API_KEY");
  const defaultPort = Number(env("CONFLUENCE_TOOL_MCP_PORT") ?? "8004");

  const missing = [
    ["ATLASSIAN_DOMAIN", domain],
    ["ATLASSIAN_EMAIL", email],
    ["ATLASSIAN_API_TOKEN", apiToken],
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(
      `Missing required env vars: ${missing.join(", ")}. ` +
      "CONFLUENCE_DOMAIN, CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN, and Jira helper aliases are also supported."
    );
  }

  if (!Number.isInteger(defaultPort) || defaultPort <= 0) {
    throw new Error("CONFLUENCE_TOOL_MCP_PORT must be a positive integer");
  }

  return { domain: domain!, email: email!, apiToken: apiToken!, defaultPort };
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
