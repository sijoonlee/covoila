import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { JiraClient } from "./jiraClient.js";

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function err(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const JsonObjectSchema = z.record(z.string(), z.unknown());

export function createJiraMcpServer(jira: JiraClient): McpServer {
  const server = new McpServer({ name: "jira-tool-mcp", version: "0.1.0" });
  registerJiraTools(server, jira);
  return server;
}

export function registerJiraTools(server: McpServer, jira: JiraClient): void {
  server.registerTool(
    "jira_create_issue",
    {
      description: "Create a Jira issue.",
      inputSchema: {
        projectKey: z.string().describe("Project key, e.g. PROJ"),
        issueType: z.string().describe("Issue type name, e.g. Task, Bug, Story"),
        summary: z.string().describe("Issue summary"),
        description: z.string().optional().describe("Plain-text issue description"),
        fields: JsonObjectSchema.optional().describe("Additional Jira fields for custom fields or advanced create payloads"),
      },
    },
    async (input) => {
      try { return ok(await jira.createIssue(input)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_get_issue",
    {
      description: "Fetch a Jira issue by key.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        fields: z.array(z.string()).optional().describe("Optional Jira fields to request"),
      },
    },
    async ({ issueKey, fields }) => {
      try { return ok(await jira.getIssue(issueKey, fields)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_search_issues",
    {
      description: "Search Jira issues using JQL.",
      inputSchema: {
        jql: z.string().describe("JQL query string"),
        maxResults: z.number().int().positive().optional().describe("Maximum results to return"),
      },
    },
    async ({ jql, maxResults }) => {
      try { return ok(await jira.searchIssues(jql, maxResults)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_update_issue",
    {
      description: "Update Jira issue fields.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        summary: z.string().optional().describe("New summary"),
        description: z.string().optional().describe("New plain-text description"),
        fields: JsonObjectSchema.optional().describe("Additional Jira fields for custom fields or advanced update payloads"),
        notifyUsers: z.boolean().optional().describe("Whether Jira should notify users"),
      },
    },
    async (input) => {
      try { return ok(await jira.updateIssue(input)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_delete_issue",
    {
      description: "Delete a Jira issue.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        deleteSubtasks: z.boolean().optional().describe("Whether to delete subtasks"),
      },
    },
    async ({ issueKey, deleteSubtasks }) => {
      try { return ok(await jira.deleteIssue(issueKey, deleteSubtasks)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_get_comments",
    {
      description: "Fetch all comments on a Jira issue.",
      inputSchema: { issueKey: z.string().describe("Issue key, e.g. PROJ-42") },
    },
    async ({ issueKey }) => {
      try { return ok(await jira.getComments(issueKey)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_add_comment",
    {
      description: "Add a plain-text comment to a Jira issue.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        text: z.string().describe("Comment text"),
      },
    },
    async ({ issueKey, text }) => {
      try { return ok(await jira.addComment(issueKey, text)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_update_comment",
    {
      description: "Update a Jira issue comment.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        commentId: z.string().describe("Jira comment ID"),
        text: z.string().describe("New comment text"),
      },
    },
    async ({ issueKey, commentId, text }) => {
      try { return ok(await jira.updateComment(issueKey, commentId, text)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_delete_comment",
    {
      description: "Delete a Jira issue comment.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        commentId: z.string().describe("Jira comment ID"),
      },
    },
    async ({ issueKey, commentId }) => {
      try { return ok(await jira.deleteComment(issueKey, commentId)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_get_transitions",
    {
      description: "List available transitions for a Jira issue.",
      inputSchema: { issueKey: z.string().describe("Issue key, e.g. PROJ-42") },
    },
    async ({ issueKey }) => {
      try { return ok(await jira.getTransitions(issueKey)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_transition_issue",
    {
      description: "Transition a Jira issue by transition ID or status name.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        targetStatus: z.string().optional().describe("Target status name"),
        transitionId: z.string().optional().describe("Jira transition ID"),
      },
    },
    async ({ issueKey, targetStatus, transitionId }) => {
      try { return ok(await jira.transitionIssue(issueKey, targetStatus, transitionId)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_assign_issue",
    {
      description: "Assign or unassign a Jira issue.",
      inputSchema: {
        issueKey: z.string().describe("Issue key, e.g. PROJ-42"),
        accountId: z.string().nullable().describe("Atlassian account ID, or null to unassign"),
      },
    },
    async ({ issueKey, accountId }) => {
      try { return ok(await jira.assignIssue(issueKey, accountId)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_search_projects",
    {
      description: "Search Jira projects by name or key.",
      inputSchema: {
        query: z.string().optional().describe("Project search query"),
      },
    },
    async ({ query }) => {
      try { return ok(await jira.searchProjects(query)); } catch (e) { return err(e); }
    }
  );

  server.registerTool(
    "jira_get_project_users",
    {
      description: "List users assignable to issues in a project.",
      inputSchema: {
        projectKey: z.string().describe("Project key, e.g. PROJ"),
      },
    },
    async ({ projectKey }) => {
      try { return ok(await jira.getProjectUsers(projectKey)); } catch (e) { return err(e); }
    }
  );
}
