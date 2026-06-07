import { adfToText, textToAdf } from "./adf.js";
import type { JiraToolConfig } from "./config.js";

export interface JiraClientOptions {
  config: JiraToolConfig;
}

export interface CreateIssueInput {
  projectKey: string;
  issueType: string;
  summary: string;
  description?: string;
  fields?: Record<string, unknown>;
}

export interface UpdateIssueInput {
  issueKey: string;
  summary?: string;
  description?: string;
  fields?: Record<string, unknown>;
  notifyUsers?: boolean;
}

export class AtlassianApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown
  ) {
    super(message);
    this.name = "AtlassianApiError";
  }
}

export class JiraClient {
  private readonly jiraBaseUrl: string;
  private readonly authHeader: string;

  constructor(options: JiraClientOptions) {
    const { domain, email, apiToken } = options.config;
    this.jiraBaseUrl = `https://${domain}/rest/api/3`;
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
  }

  async createIssue(input: CreateIssueInput): Promise<unknown> {
    const fields: Record<string, unknown> = {
      ...(input.fields ?? {}),
      project: { key: input.projectKey },
      issuetype: { name: input.issueType },
      summary: input.summary,
    };

    if (input.description !== undefined) {
      fields.description = textToAdf(input.description);
    }

    return this.request("/issue", {
      method: "POST",
      body: { fields },
    });
  }

  async getIssue(issueKey: string, fields?: string[]): Promise<unknown> {
    const data = await this.request<Record<string, unknown>>(`/issue/${encodeURIComponent(issueKey)}`, {
      query: {
        fields: fields?.join(",") || "summary,issuetype,priority,status,description,assignee,project,reporter,created,updated",
      },
    });
    return this.normalizeIssue(data);
  }

  async searchIssues(jql: string, maxResults = 50): Promise<unknown[]> {
    const data = await this.request<{ issues?: unknown[] }>("/search", {
      query: { jql, maxResults: String(maxResults) },
    });
    return (data.issues ?? []).map((issue) => this.normalizeIssue(issue));
  }

  async updateIssue(input: UpdateIssueInput): Promise<{ updated: true; issueKey: string }> {
    const fields: Record<string, unknown> = { ...(input.fields ?? {}) };

    if (input.summary !== undefined) fields.summary = input.summary;
    if (input.description !== undefined) fields.description = textToAdf(input.description);

    if (Object.keys(fields).length === 0) {
      throw new Error("At least one update field is required");
    }

    await this.request(`/issue/${encodeURIComponent(input.issueKey)}`, {
      method: "PUT",
      query: input.notifyUsers === undefined ? undefined : { notifyUsers: String(input.notifyUsers) },
      body: { fields },
    });

    return { updated: true, issueKey: input.issueKey };
  }

  async deleteIssue(issueKey: string, deleteSubtasks = false): Promise<{ deleted: true; issueKey: string }> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}`, {
      method: "DELETE",
      query: { deleteSubtasks: String(deleteSubtasks) },
    });
    return { deleted: true, issueKey };
  }

  async getComments(issueKey: string): Promise<unknown[]> {
    const comments: unknown[] = [];
    let startAt = 0;
    const maxResults = 100;

    while (true) {
      const data = await this.request<{ comments?: unknown[]; total?: number }>(
        `/issue/${encodeURIComponent(issueKey)}/comment`,
        { query: { startAt: String(startAt), maxResults: String(maxResults) } }
      );
      const page = data.comments ?? [];
      comments.push(...page.map((comment) => this.normalizeComment(comment)));
      if (comments.length >= (data.total ?? comments.length) || page.length === 0) break;
      startAt += maxResults;
    }

    return comments;
  }

  async addComment(issueKey: string, text: string): Promise<unknown> {
    const data = await this.request(`/issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: { body: textToAdf(text) },
    });
    return this.normalizeComment(data);
  }

  async updateComment(issueKey: string, commentId: string, text: string): Promise<unknown> {
    const data = await this.request(`/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
      method: "PUT",
      body: { body: textToAdf(text) },
    });
    return this.normalizeComment(data);
  }

  async deleteComment(issueKey: string, commentId: string): Promise<{ deleted: true; issueKey: string; commentId: string }> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(commentId)}`, {
      method: "DELETE",
    });
    return { deleted: true, issueKey, commentId };
  }

  async getTransitions(issueKey: string): Promise<unknown[]> {
    const data = await this.request<{ transitions?: unknown[] }>(`/issue/${encodeURIComponent(issueKey)}/transitions`);
    return data.transitions ?? [];
  }

  async transitionIssue(issueKey: string, targetStatus?: string, transitionId?: string): Promise<unknown> {
    let id = transitionId;
    if (!id) {
      if (!targetStatus) throw new Error("Either targetStatus or transitionId is required");
      const transitions = await this.getTransitions(issueKey) as Array<Record<string, unknown>>;
      const match = transitions.find((transition) =>
        String(transition.name ?? "").toLowerCase() === targetStatus.toLowerCase()
      );
      if (!match?.id) {
        const available = transitions.map((transition) => String(transition.name ?? "")).filter(Boolean).join(", ");
        throw new Error(`Transition "${targetStatus}" not found for ${issueKey}. Available: ${available}`);
      }
      id = String(match.id);
    }

    await this.request(`/issue/${encodeURIComponent(issueKey)}/transitions`, {
      method: "POST",
      body: { transition: { id } },
    });
    return { transitioned: true, issueKey, transitionId: id, targetStatus };
  }

  async assignIssue(issueKey: string, accountId: string | null): Promise<unknown> {
    await this.request(`/issue/${encodeURIComponent(issueKey)}/assignee`, {
      method: "PUT",
      body: { accountId },
    });
    return { assigned: true, issueKey, accountId };
  }

  async searchProjects(query?: string): Promise<unknown> {
    return this.request("/project/search", { query: query ? { query } : undefined });
  }

  async getProjectUsers(projectKey: string): Promise<unknown> {
    return this.request("/user/assignable/search", { query: { project: projectKey } });
  }

  private async request<T = unknown>(path: string, options: {
    method?: string;
    query?: Record<string, string>;
    body?: unknown;
  } = {}): Promise<T> {
    const url = new URL(`${this.jiraBaseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      url.searchParams.set(key, value);
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const responseBody = await parseResponseBody(response);
    if (!response.ok) {
      throw new AtlassianApiError(formatApiError(response.status, responseBody), response.status, responseBody);
    }

    return responseBody as T;
  }

  private normalizeIssue(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    const issue = raw as Record<string, unknown>;
    const fields = (issue.fields && typeof issue.fields === "object" ? issue.fields : {}) as Record<string, unknown>;
    const project = objectField(fields.project);
    const status = objectField(fields.status);
    const statusCategory = objectField(status.statusCategory);
    const issueType = objectField(fields.issuetype);
    const priority = objectField(fields.priority);
    const assignee = objectField(fields.assignee);
    const reporter = objectField(fields.reporter);

    return {
      id: issue.id,
      key: issue.key,
      self: issue.self,
      summary: fields.summary,
      description: adfToText(fields.description).trim() || null,
      issueType: issueType.name ?? null,
      priority: priority.name ?? null,
      status: status.name ? {
        id: status.id,
        name: status.name,
        statusCategory: statusCategory.name ? { key: statusCategory.key, name: statusCategory.name } : null,
      } : null,
      project: project.key ? { id: project.id, key: project.key, name: project.name } : null,
      assignee: assignee.displayName ? { accountId: assignee.accountId, displayName: assignee.displayName } : null,
      reporter: reporter.displayName ? { accountId: reporter.accountId, displayName: reporter.displayName } : null,
      created: fields.created,
      updated: fields.updated,
    };
  }

  private normalizeComment(raw: unknown): unknown {
    if (!raw || typeof raw !== "object") return raw;
    const comment = raw as Record<string, unknown>;
    const author = objectField(comment.author);
    return {
      id: comment.id,
      author: author.displayName ? { accountId: author.accountId, displayName: author.displayName } : null,
      body: adfToText(comment.body).trim(),
      created: comment.created,
      updated: comment.updated,
    };
  }
}

function objectField(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

async function parseResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function formatApiError(status: number, body: unknown): string {
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    const messages = [
      ...(Array.isArray(record.errorMessages) ? record.errorMessages.map(String) : []),
      ...Object.entries(objectField(record.errors)).map(([key, value]) => `${key}: ${String(value)}`),
    ];
    if (messages.length > 0) return `Jira API ${status}: ${messages.join("; ")}`;
  }
  return `Jira API ${status}: ${typeof body === "string" ? body : "request failed"}`;
}
