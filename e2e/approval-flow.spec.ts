import { createServer } from "node:http";
import { AddressInfo } from "node:net";

import { expect, test } from "@playwright/test";

import { demoRequests } from "../src/fixtures";
import type { ApprovalDecision, ApprovalRequest } from "../src/types";

type Bridge = {
  decisions: ApprovalDecision[];
  failLists(): void;
  recoverWith(requests: ApprovalRequest[]): void;
  url: string;
  close(): Promise<void>;
};

async function startBridge(
  requests: ApprovalRequest[] = demoRequests,
): Promise<Bridge> {
  let pending = requests.map((request) => ({ ...request }));
  let listStatus = 200;
  const decisions: ApprovalDecision[] = [];

  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");

    if (request.method === "OPTIONS") {
      response.writeHead(204).end();
      return;
    }

    if (request.method === "GET" && request.url === "/api/approval-requests") {
      if (listStatus !== 200) {
        response.writeHead(listStatus).end();
        return;
      }
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(pending));
      return;
    }

    const decisionMatch = request.url?.match(
      /^\/api\/approval-requests\/([^/]+)\/decision$/,
    );
    if (request.method === "POST" && decisionMatch) {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const decision = JSON.parse(
          Buffer.concat(chunks).toString("utf8"),
        ) as ApprovalDecision;
        decisions.push(decision);
        pending = pending.filter(
          (approvalRequest) => approvalRequest.id !== decisionMatch[1],
        );
        response.writeHead(204).end();
      });
      return;
    }

    response.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    decisions,
    failLists() {
      listStatus = 503;
    },
    recoverWith(nextRequests: ApprovalRequest[]) {
      listStatus = 200;
      pending = nextRequests.map((request) => ({ ...request }));
    },
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

test("prioritizes allowlister fragments and supports the demo approval flow", async ({
  page,
}) => {
  await page.goto("/?demo=1");

  await expect(
    page.getByRole("heading", { name: /Approve the action/ }),
  ).toBeVisible();
  await expect(page.getByLabel("Important commands")).toContainText(
    "gh pr merge 42 --squash --delete-branch",
  );
  await expect(page.getByLabel("Risk signals")).toContainText("GitHub write");
  await expect(page.getByText("Parsed allowlister fragments")).toBeVisible();
  await expect(page.getByText("/workspace/acme-api")).toBeVisible();

  await page.getByRole("button", { name: "Allow once" }).click();

  await expect(
    page.getByRole("heading", { name: "No pending approvals" }),
  ).toBeVisible();
});

test("keeps the complete script available but secondary", async ({ page }) => {
  await page.goto("/?demo=1");

  await page.getByText("Show full script").click();

  await expect(
    page.getByText("git diff --stat && npm test && gh pr merge 42"),
  ).toBeVisible();
});

test("drives the real bridge API across request, decision, and recovery paths", async ({
  page,
}) => {
  const bridge = await startBridge();
  try {
    await page.goto(`/?bridge=${encodeURIComponent(bridge.url)}`);

    await expect(page.getByText("demo-deploy-1")).toBeVisible();
    await page.getByRole("button", { name: "Deny" }).click();

    await expect(
      page.getByRole("heading", { name: "No pending approvals" }),
    ).toBeVisible();
    expect(bridge.decisions).toEqual([
      {
        requestId: "demo-deploy-1",
        verdict: "deny",
        reason: "denied in allowlister-remote",
      },
    ]);

    bridge.failLists();
    await expect(page.getByRole("alert")).toHaveText(
      "request list failed: 503",
    );

    bridge.recoverWith(demoRequests);
    await expect(page.getByText("demo-deploy-1")).toBeVisible();
    await expect(page.getByRole("alert")).toBeHidden();
  } finally {
    await bridge.close();
  }
});
