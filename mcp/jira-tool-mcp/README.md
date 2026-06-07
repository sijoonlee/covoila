# jira-tool-mcp

CLI and MCP server for Jira Cloud ticket operations.

## Setup

Create a `.env` file in this directory or export the variables:

```env
ATLASSIAN_DOMAIN=yourcompany.atlassian.net
ATLASSIAN_EMAIL=you@example.com
ATLASSIAN_API_TOKEN=your-api-token
JIRA_TOOL_MCP_PORT=8003
```

Backward-compatible `JIRA_DOMAIN`, `JIRA_EMAIL`, and `JIRA_API_KEY` aliases are also supported.

## Commands

Run as an MCP server:

```bash
pnpm --dir mcp/jira-tool-mcp run dev -- serve --transport stdio
pnpm --dir mcp/jira-tool-mcp run dev -- serve --transport http --port 8003
```

Use direct Jira commands:

```bash
pnpm --dir mcp/jira-tool-mcp run dev -- issue get PROJ-42
pnpm --dir mcp/jira-tool-mcp run dev -- issue search --jql 'project = PROJ ORDER BY updated DESC'
pnpm --dir mcp/jira-tool-mcp run dev -- issue create --project PROJ --type Task --summary "Add login" --description "Implement login flow"
pnpm --dir mcp/jira-tool-mcp run dev -- issue update PROJ-42 --summary "Updated title"
pnpm --dir mcp/jira-tool-mcp run dev -- issue delete PROJ-42 --confirm
```

Build:

```bash
pnpm --dir mcp/jira-tool-mcp run build
```

## MCP Tools

- `jira_create_issue`
- `jira_get_issue`
- `jira_search_issues`
- `jira_update_issue`
- `jira_delete_issue`
- `jira_get_comments`
- `jira_add_comment`
- `jira_update_comment`
- `jira_delete_comment`
- `jira_get_transitions`
- `jira_transition_issue`
- `jira_assign_issue`
- `jira_search_projects`
- `jira_get_project_users`
