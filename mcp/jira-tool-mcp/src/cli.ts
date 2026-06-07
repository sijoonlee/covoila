import { readFileSync } from "node:fs";
import { getConfig } from "./config.js";
import { JiraClient } from "./jiraClient.js";
import { serveHttp, serveStdio, type TransportName } from "./server.js";

export async function runCli(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  const config = getConfig();
  const jira = new JiraClient({ config });

  if (command === "serve") {
    await runServe(jira, rest, config.defaultPort);
    return;
  }

  if (command === "issue") {
    await runIssueCommand(jira, rest);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

async function runServe(jira: JiraClient, args: string[], defaultPort: number): Promise<void> {
  const flags = parseFlags(args);
  const transport = (flags.transport ?? "stdio") as TransportName;

  if (transport === "stdio") {
    await serveStdio(jira);
    return;
  }

  if (transport === "http") {
    await serveHttp(jira, flags.port ? positiveInt(flags.port, "port") : defaultPort);
    return;
  }

  throw new Error("--transport must be stdio or http");
}

async function runIssueCommand(jira: JiraClient, args: string[]): Promise<void> {
  const [action, issueKey, ...rest] = args;
  const flags = parseFlags(action === "create" || action === "search" ? args.slice(1) : rest);

  switch (action) {
    case "create": {
      const projectKey = requireFlag(flags, "project");
      const issueType = requireFlag(flags, "type");
      const summary = requireFlag(flags, "summary");
      const description = readTextFlag(flags, "description", "description-file");
      const fields = parseJsonObjectFlag(flags, "fields");
      printJson(await jira.createIssue({ projectKey, issueType, summary, description, fields }));
      return;
    }

    case "get": {
      requireArg(issueKey, "issue key");
      const fields = flags.fields ? flags.fields.split(",").map((field) => field.trim()).filter(Boolean) : undefined;
      printJson(await jira.getIssue(issueKey, fields));
      return;
    }

    case "search": {
      const jql = requireFlag(flags, "jql");
      const maxResults = flags.max ? positiveInt(flags.max, "max") : undefined;
      printJson(await jira.searchIssues(jql, maxResults));
      return;
    }

    case "update": {
      requireArg(issueKey, "issue key");
      const description = readTextFlag(flags, "description", "description-file");
      const fields = parseJsonObjectFlag(flags, "fields");
      printJson(await jira.updateIssue({
        issueKey,
        summary: flags.summary,
        description,
        fields,
        notifyUsers: flags["notify-users"] === undefined ? undefined : parseBoolean(flags["notify-users"], "notify-users"),
      }));
      return;
    }

    case "delete": {
      requireArg(issueKey, "issue key");
      if (flags.confirm !== "true") {
        throw new Error("Refusing to delete without --confirm");
      }
      printJson(await jira.deleteIssue(issueKey, parseBoolean(flags["delete-subtasks"] ?? "false", "delete-subtasks")));
      return;
    }

    default:
      throw new Error(`Unknown issue command: ${action ?? ""}`);
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) continue;

    const withoutPrefix = arg.slice(2);
    const equalsIndex = withoutPrefix.indexOf("=");
    if (equalsIndex >= 0) {
      flags[withoutPrefix.slice(0, equalsIndex)] = withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const next = args[i + 1];
    if (!next || next.startsWith("--")) {
      flags[withoutPrefix] = "true";
      continue;
    }

    flags[withoutPrefix] = next;
    i += 1;
  }
  return flags;
}

function requireFlag(flags: Record<string, string>, name: string): string {
  const value = flags[name];
  if (!value || value === "true") throw new Error(`--${name} is required`);
  return value;
}

function requireArg(value: string | undefined, name: string): asserts value is string {
  if (!value) throw new Error(`${name} is required`);
}

function readTextFlag(flags: Record<string, string>, inlineName: string, fileName: string): string | undefined {
  if (flags[fileName]) return readFileSync(flags[fileName], "utf8");
  return flags[inlineName];
}

function parseJsonObjectFlag(flags: Record<string, string>, name: string): Record<string, unknown> | undefined {
  if (!flags[name]) return undefined;
  const parsed = JSON.parse(flags[name]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`--${name} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`--${name} must be true or false`);
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function printUsage(): void {
  process.stdout.write(`jira-tool-mcp

Usage:
  jira-tool-mcp serve --transport stdio
  jira-tool-mcp serve --transport http --port 8003
  jira-tool-mcp issue get PROJ-42
  jira-tool-mcp issue search --jql "project = PROJ" --max 25
  jira-tool-mcp issue create --project PROJ --type Task --summary "Title" [--description "..."] [--fields '{"customfield_10000":"value"}']
  jira-tool-mcp issue update PROJ-42 [--summary "Title"] [--description "..."] [--fields '{"priority":{"name":"High"}}']
  jira-tool-mcp issue delete PROJ-42 --confirm [--delete-subtasks true]
`);
}
