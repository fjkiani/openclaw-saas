import { config } from "./config.js";

export interface ArchonRunRequest {
  conversationId?: string;
  message: string;
}

export interface ArchonRunResponse {
  runId: string;
  conversationId: string;
  status: string;
}

export interface ArchonRunStatus {
  id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

export async function triggerArchonWorkflow(
  workflowName: string,
  message: string,
  conversationId?: string
): Promise<ArchonRunResponse> {
  const res = await fetch(
    `${config.archonServiceUrl}/api/workflows/${workflowName}/run`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, conversationId }),
    }
  );

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Archon workflow trigger failed ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { conversationId: string; runId?: string };
  return {
    runId: data.runId ?? data.conversationId,
    conversationId: data.conversationId,
    status: "pending",
  };
}

export async function getArchonRunStatus(runId: string): Promise<ArchonRunStatus> {
  const res = await fetch(
    `${config.archonServiceUrl}/api/workflow-runs/${runId}`
  );

  if (!res.ok) {
    throw new Error(`Archon status fetch failed ${res.status}`);
  }

  return (await res.json()) as ArchonRunStatus;
}
