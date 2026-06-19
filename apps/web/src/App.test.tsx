import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App inbox", () => {
  it("lists every pending allowlister request as an inbox entry", async () => {
    render(<App />);

    const list = await screen.findByRole("list", { name: "Pending approvals" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(list).getByText("gh pr merge 42 --squash --delete-branch")).toBeInTheDocument();
    // The longer script headlines on its first flagged fragment, not the script.
    expect(within(list).getByText("npm publish --access public")).toBeInTheDocument();
    expect(within(list).getByText("mcp__github__create_issue")).toBeInTheDocument();
    expect(screen.getByText(/4 pending approvals/)).toBeInTheDocument();
  });

  it("allows a request directly from the inbox list without opening it", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: "Allow gh pr merge 42 --squash --delete-branch",
      }),
    );

    await waitFor(() => {
      expect(screen.getByText(/3 pending approvals/)).toBeInTheDocument();
    });
    expect(screen.queryByText("gh pr merge 42 --squash --delete-branch")).not.toBeInTheDocument();
  });

  it("opens a shell approval and shows the real per-fragment verdicts", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Open approval for npm publish --access public" }),
    );

    expect(screen.getByText(/Approve the action/)).toBeInTheDocument();

    // Only the two tripping fragments appear under "needs your attention".
    const flagged = screen.getByLabelText("Flagged commands");
    expect(within(flagged).getByText("npm publish --access public")).toBeInTheDocument();
    expect(within(flagged).getByText("git push origin main --tags")).toBeInTheDocument();
    expect(within(flagged).queryByText("npm ci")).not.toBeInTheDocument();

    // The full decomposition still lists every fragment with its verdict.
    expect(screen.getByText("ask before publishing a package")).toBeInTheDocument();
    expect(screen.getByText("/workspace/acme-api")).toBeInTheDocument();

    await user.click(screen.getByText("Show full script"));
    const fullScript = screen.getByText(
      (_, element) =>
        element?.tagName === "PRE" && (element.textContent ?? "").includes("set -euo pipefail"),
    );
    expect(fullScript.textContent).toContain('echo "release complete"');

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => {
      expect(screen.getByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
    });
  });

  it("opens a tool call and toggles between formatted and JSON views", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Open approval for mcp__github__create_issue" }),
    );

    expect(screen.getByText("Approve this tool call")).toBeInTheDocument();

    // Formatted view shows the canonical capability and the raw input.
    const formatted = screen.getByLabelText("Tool call formatted view");
    expect(within(formatted).getByText("capability: mcp")).toBeInTheDocument();
    expect(within(formatted).getByText("Production is down")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "JSON" }));
    const json = screen.getByLabelText("Tool call JSON view");
    expect(json.textContent).toContain('"capability": "mcp"');
    expect(json.textContent).toContain('"name": "mcp__github__create_issue"');
  });

  it("returns to the inbox from the expanded view via the back control", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open approval for write" }));
    expect(screen.getByText("Approve this tool call")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /All approvals/ }));

    expect(await screen.findByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
  });

  it("shows the empty state once every request is decided", async () => {
    const user = userEvent.setup();
    render(<App />);

    for (const name of [
      "Deny gh pr merge 42 --squash --delete-branch",
      "Deny npm publish --access public",
      "Deny mcp__github__create_issue",
      "Deny write",
    ]) {
      await user.click(await screen.findByRole("button", { name }));
    }

    await waitFor(() => {
      expect(screen.getByText("No pending approvals")).toBeInTheDocument();
    });
  });
});
