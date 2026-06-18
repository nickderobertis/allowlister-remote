import { demoRequests } from "./fixtures";
import type { ApprovalDecision, ApprovalRequest } from "./types";

export interface ApprovalApi {
  listRequests(): Promise<ApprovalRequest[]>;
  decide(decision: ApprovalDecision): Promise<void>;
}

export class HttpApprovalApi implements ApprovalApi {
  private readonly baseUrl: string;

  constructor(baseUrl = "") {
    this.baseUrl = baseUrl;
  }

  async listRequests(): Promise<ApprovalRequest[]> {
    const response = await fetch(`${this.baseUrl}/api/approval-requests`);
    if (!response.ok) {
      throw new Error(`request list failed: ${response.status}`);
    }
    return (await response.json()) as ApprovalRequest[];
  }

  async decide(decision: ApprovalDecision): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/api/approval-requests/${decision.requestId}/decision`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision),
      },
    );
    if (!response.ok) {
      throw new Error(`decision failed: ${response.status}`);
    }
  }
}

export class DemoApprovalApi implements ApprovalApi {
  private requests = [...demoRequests];
  readonly decisions: ApprovalDecision[] = [];

  async listRequests(): Promise<ApprovalRequest[]> {
    return this.requests;
  }

  async decide(decision: ApprovalDecision): Promise<void> {
    this.decisions.push(decision);
    this.requests = this.requests.filter(
      (request) => request.id !== decision.requestId,
    );
  }
}

export function createApprovalApi(): ApprovalApi {
  const params = new URLSearchParams(window.location.search);
  const bridgeUrl = params.get("bridge");
  if (bridgeUrl) {
    return new HttpApprovalApi(bridgeUrl);
  }
  if (params.get("demo") === "1" || import.meta.env.DEV) {
    return new DemoApprovalApi();
  }
  return new HttpApprovalApi();
}
