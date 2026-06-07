# MCP Atlassian Tools Plan

## Goal

Build command-line runnable MCP tools for Atlassian Cloud, divided into separate Jira and Confluence tools:

- A Jira MCP tool for CRUD operations on Jira tickets.
- A Confluence MCP tool for CRUD operations on Confluence pages.

The tools should share authentication/configuration utilities, but their clients, MCP registrations, CLI commands, tests, and release entrypoints should remain separate. The best starting point for Jira is the prior implementation in:

`/Users/sijoonlee/Documents/coding/project-wah-lah/services/jira-helper`

That service already has a TypeScript MCP server over Streamable HTTP, an Express REST surface, and a Jira client for reading/updating issues, comments, transitions, boards, projects, and assignable users. The new Jira tool should reuse its structure and extend it rather than reimplementing the MCP plumbing. The Confluence tool should reuse only the shared MCP/config/client patterns, not Jira-specific code.

## Official API References

- Jira Cloud REST API v3 intro: https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/
- Jira Cloud issue endpoints: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issues/
- Jira Cloud comments endpoints: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-comments/
- Jira Cloud search/JQL endpoints: https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-issue-search/
- Jira Cloud Agile API: https://developer.atlassian.com/cloud/jira/software/rest/api-group-board/
- Confluence Cloud REST API v2 intro: https://developer.atlassian.com/cloud/confluence/rest/v2/intro/
- Confluence Cloud page endpoints: https://developer.atlassian.com/cloud/confluence/rest/v2/api-group-page/
- Atlassian Basic auth with API tokens: https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/
- Atlassian API token management: https://id.atlassian.com/manage-profile/security/api-tokens

## Current Reusable Work

The previous helper already provides:

- `src/index.ts`: loads `.env`, creates a Jira client, starts Express.
- `src/server.ts`: mounts `/health`, `/api/jira`, and `/mcp`; uses `StreamableHTTPServerTransport` in stateless mode.
- `src/mcp.ts`: registers Jira tools with `@modelcontextprotocol/sdk`.
- `src/rest.ts`: exposes HTTP routes for Jira operations.
- `src/jira.ts`: wraps Jira Cloud REST API v3 and Agile API calls with axios.
- Existing environment variables: `JIRA_DOMAIN`, `JIRA_EMAIL`, `JIRA_API_KEY`, `JIRA_HELPER_PORT`.

Existing Jira MCP tools:

- `jira_get_issue`
- `jira_update_description`
- `jira_search_issues`
- `jira_get_transitions`
- `jira_transition_issue`
- `jira_assign_issue`
- `jira_get_comments`
- `jira_add_comment`
- `jira_update_comment`
- `jira_delete_comment`
- `jira_get_boards`
- `jira_get_board_issues`
- `jira_search_projects`
- `jira_get_project_users`

Missing for the requested CRUD scope:

- Jira issue create.
- Jira issue update beyond description/assignee/status/comment.
- Jira issue delete.
- Confluence page create/read/update/delete.
- CLI command surface if we want a direct command-line tool in addition to MCP client invocation.

## Proposed Package Shape

Create two runnable tool packages under `mcp`, with a small shared package for common Atlassian Cloud plumbing when both tools exist:

```text
mcp/
  README.md
  package.json            # workspace root for the MCP tools
  tsconfig.base.json
  .env.example
  shared-atlassian/
    package.json
    src/
      config.ts           # env loading and validation
      auth.ts             # Basic auth header helpers
      http.ts             # HTTP client factory and error normalization
      mcp.ts              # shared MCP response helpers
  jira-tool-mcp/
    package.json
    src/
      index.ts            # jira-tool-mcp CLI entrypoint
      server.ts           # Jira MCP transport setup
      jiraClient.ts       # Jira API wrapper
      adf.ts              # Jira plain-text to ADF helpers
      jiraTools.ts        # Jira MCP tool registration
      cli.ts              # direct Jira commands
  confluence-tool-mcp/
    package.json
    src/
      index.ts            # confluence CLI entrypoint
      server.ts           # Confluence MCP transport setup
      confluenceClient.ts
      content.ts          # Markdown/storage/ADF page body helpers
      confluenceTools.ts
      cli.ts              # direct Confluence commands
```

Keep the implementation close to `jira-helper` to reduce risk:

- Use Node.js, TypeScript, `@modelcontextprotocol/sdk`, `zod`, `axios`, and `dotenv`.
- Keep MCP as the primary interface for each tool.
- Add a CLI mode in each tool that can run its MCP server via stdio or HTTP, plus direct CRUD commands for quick terminal use.
- Keep a single shared auth/config library so credentials and HTTP error handling are consistent.
- Prefer Atlassian Cloud REST APIs. Do not target Jira/Confluence Data Center unless added later.

## Authentication And Configuration

Use one Atlassian Cloud domain and one user API token for both products:

```env
ATLASSIAN_DOMAIN=yourcompany.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=your-api-token
ATLASSIAN_MCP_PORT=8003
ATLASSIAN_MCP_TRANSPORT=http
```

Compatibility aliases can be supported for the prior helper:

```env
JIRA_DOMAIN=yourcompany.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_KEY=your-api-token
```

Axios base URLs:

- Jira platform: `https://${ATLASSIAN_DOMAIN}/rest/api/3`
- Jira Agile: `https://${ATLASSIAN_DOMAIN}/rest/agile/1.0`
- Confluence v2: `https://${ATLASSIAN_DOMAIN}/wiki/api/v2`

Auth:

- Basic auth header: `Authorization: Basic base64(email:apiToken)`.
- Send `Accept: application/json`.
- Send `Content-Type: application/json` for JSON requests.

## Tool Scope

### Jira Tool

Implement full issue CRUD and keep existing workflow/comment helpers.

| Tool | Inputs | API |
|------|--------|-----|
| `jira_create_issue` | `projectKey`, `issueType`, `summary`, `description?`, `fields?` | `POST /rest/api/3/issue` |
| `jira_get_issue` | `issueKey`, `fields?` | `GET /rest/api/3/issue/{issueIdOrKey}` |
| `jira_search_issues` | `jql`, `maxResults?` | `GET /rest/api/3/search` or current Cloud search endpoint if Jira deprecates old search |
| `jira_update_issue` | `issueKey`, `summary?`, `description?`, `fields?`, `notifyUsers?` | `PUT /rest/api/3/issue/{issueIdOrKey}` |
| `jira_delete_issue` | `issueKey`, `deleteSubtasks?` | `DELETE /rest/api/3/issue/{issueIdOrKey}` |
| `jira_get_comments` | `issueKey` | `GET /rest/api/3/issue/{issueIdOrKey}/comment` |
| `jira_add_comment` | `issueKey`, `text` | `POST /rest/api/3/issue/{issueIdOrKey}/comment` |
| `jira_update_comment` | `issueKey`, `commentId`, `text` | `PUT /rest/api/3/issue/{issueIdOrKey}/comment/{id}` |
| `jira_delete_comment` | `issueKey`, `commentId` | `DELETE /rest/api/3/issue/{issueIdOrKey}/comment/{id}` |
| `jira_get_transitions` | `issueKey` | `GET /rest/api/3/issue/{issueIdOrKey}/transitions` |
| `jira_transition_issue` | `issueKey`, `targetStatus` or `transitionId` | `POST /rest/api/3/issue/{issueIdOrKey}/transitions` |
| `jira_assign_issue` | `issueKey`, `accountId \| null` | `PUT /rest/api/3/issue/{issueIdOrKey}/assignee` |

Notes:

- Use Atlassian Document Format for Jira descriptions/comments, matching the prior helper.
- Accept plain text for common flows and expose a `fields` escape hatch for custom fields.
- For create/update, pass caller-provided `fields` through after validating it is an object.
- For delete, include a confirmation guard at the CLI layer because the operation is destructive.

Recommended binary/package name:

- `jira-tool-mcp`

Recommended MCP server names:

- HTTP/stdio server name: `jira-tool-mcp`
- Tool names keep the `jira_*` prefix.

### Confluence Tool

Implement page CRUD against Confluence Cloud REST API v2.

| Tool | Inputs | API |
|------|--------|-----|
| `confluence_create_page` | `spaceId`, `title`, `body`, `parentId?`, `status?` | `POST /wiki/api/v2/pages` |
| `confluence_get_page` | `pageId`, `bodyFormat?` | `GET /wiki/api/v2/pages/{id}` |
| `confluence_search_pages` | `spaceId?`, `title?`, `status?`, `limit?` | `GET /wiki/api/v2/pages` |
| `confluence_update_page` | `pageId`, `title`, `body`, `versionNumber`, `status?` | `PUT /wiki/api/v2/pages/{id}` |
| `confluence_delete_page` | `pageId` | `DELETE /wiki/api/v2/pages/{id}` |

Notes:

- Confluence updates require the next page version number. The tool should support either:
  - explicit `versionNumber`, or
  - `autoVersion: true`, where the client fetches the page first and uses `currentVersion + 1`.
- `body-format` should support at least `storage` for HTML-like Confluence storage and `atlas_doc_format` where practical.
- For a command-line user, support Markdown input by converting Markdown to Confluence storage HTML before sending. Keep plain storage format available for exact control.
- Return page `id`, `title`, `status`, `spaceId`, `parentId`, `version`, and links in normalized responses.

Recommended binary/package name:

- `confluence-tool-mcp`

Recommended MCP server names:

- HTTP/stdio server name: `confluence-tool-mcp`
- Tool names keep the `confluence_*` prefix.

## CLI Surface

Support both MCP server startup and direct terminal commands, split by product.

Jira server commands:

```bash
jira-tool-mcp serve --transport stdio
jira-tool-mcp serve --transport http --port 8003
```

Jira examples:

```bash
jira-tool-mcp issue create --project PROJ --type Task --summary "Add login" --description "Implement login flow"
jira-tool-mcp issue get PROJ-42
jira-tool-mcp issue update PROJ-42 --summary "Updated title"
jira-tool-mcp issue delete PROJ-42 --confirm
jira-tool-mcp issue search --jql 'project = PROJ ORDER BY updated DESC' --max 25
```

Confluence server commands:

```bash
confluence-tool-mcp serve --transport stdio
confluence-tool-mcp serve --transport http --port 8004
```

Confluence examples:

```bash
confluence-tool-mcp page create --space-id 12345 --title "Runbook" --body-file ./runbook.md --format markdown
confluence-tool-mcp page get 98765 --body-format storage
confluence-tool-mcp page update 98765 --title "Runbook" --body-file ./runbook.md --auto-version
confluence-tool-mcp page delete 98765 --confirm
confluence-tool-mcp page search --space-id 12345 --title "Runbook"
```

Output defaults:

- JSON to stdout for scripting.
- Non-zero exit code on API/client errors.
- Redact auth values from errors/logs.

## Implementation Phases

1. Bootstrap package
   - Add `mcp/package.json`, `tsconfig.base.json`, `.env.example`, and package layout.
   - Create `shared-atlassian`, `jira-tool-mcp`, and `confluence-tool-mcp`.
   - Copy/adapt the prior helper's MCP server and Jira client patterns into `jira-tool-mcp`.
   - Use the same transport behavior in both tools. For command-line MCP tools, stdio should be the default; keep HTTP as an option because the prior helper already works that way.

2. Shared Atlassian client
   - Add one auth/config loader.
   - Add axios clients for Jira platform, Jira Agile, and Confluence.
   - Normalize Atlassian API errors into concise MCP/CLI responses.

3. Complete `jira-tool-mcp`
   - Port current Jira methods.
   - Add `createIssue`, generic `updateIssue`, and `deleteIssue`.
   - Keep existing comment, transition, board, project, and user helpers.
   - Add MCP tools and CLI commands.

4. Add `confluence-tool-mcp`
   - Implement `createPage`, `getPage`, `searchPages`, `updatePage`, `deletePage`.
   - Implement version handling for page updates.
   - Add MCP tools and CLI commands.

5. Content conversion
   - Keep Jira ADF helper from prior work.
   - Add simple plain-text to ADF conversion.
   - Add Markdown-to-storage conversion for Confluence if a lightweight dependency is acceptable.
   - Preserve a raw `storage` mode for advanced Confluence page bodies.

6. Safety and ergonomics
   - Require `--confirm` for CLI delete commands.
   - Add dry-run output for create/update/delete commands if useful.
   - Add pagination helpers for Jira search/comments and Confluence page listing.

7. Tests and validation
   - Unit-test ADF conversion, config loading, argument parsing, and response normalization.
   - Mock axios for Jira/Confluence client tests.
   - Smoke-test MCP `initialize` and `tools/list`.
   - Optionally add live smoke tests guarded by env vars and clearly marked as destructive/non-destructive.

## Acceptance Criteria

- Running `jira-tool-mcp serve --transport stdio` exposes only Jira tools to an MCP client.
- Running `confluence-tool-mcp serve --transport stdio` exposes only Confluence tools to an MCP client.
- Running `jira-tool-mcp serve --transport http --port 8003` exposes a Jira-only HTTP MCP endpoint compatible with the prior helper style.
- Running `confluence-tool-mcp serve --transport http --port 8004` exposes a Confluence-only HTTP MCP endpoint.
- Jira commands/tools can create, read, update, delete, search, comment, transition, and assign issues.
- Confluence commands/tools can create, read, update, delete, and search pages.
- Direct product-specific CLI commands work without an MCP client.
- The implementation supports Atlassian Cloud with API-token Basic auth.
- Destructive CLI operations require explicit confirmation.
- Tests cover client request construction and MCP tool registration without hitting real Atlassian APIs.

## Open Decisions

- Whether to support only Cloud or also Jira/Confluence Data Center. Current recommendation: Cloud only.
- Whether to keep REST endpoints in addition to MCP and CLI. Current recommendation: skip REST unless the app needs browser/internal HTTP use. If kept, expose separate `/api/jira/*` and `/api/confluence/*` servers rather than one combined app.
- Whether Confluence body input should be Markdown-first or storage-HTML-first. Current recommendation: Markdown-first for CLI, storage escape hatch for exact Confluence control.
- Whether to vendor the previous helper code or copy the relevant parts into this repo. Current recommendation: copy/adapt Jira-specific parts into `mcp/jira-tool-mcp` so this repo owns the resulting tool.
