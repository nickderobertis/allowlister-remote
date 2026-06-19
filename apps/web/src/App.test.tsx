import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App inbox", () => {
  it("lists every pending allowlister request as an inbox entry", async () => {
    render(<App />);

    const list = await screen.findByRole("list", { name: "Pending approvals" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(within(list).getByText("gh pr merge 42 --squash --delete-branch")).toBeInTheDocument();
    expect(within(list).getByText("rm -rf dist")).toBeInTheDocument();
    expect(screen.getByText(/2 pending approvals/)).toBeInTheDocument();
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
      expect(screen.getByText(/1 pending approval\b/)).toBeInTheDocument();
    });
    expect(screen.queryByText("gh pr merge 42 --squash --delete-branch")).not.toBeInTheDocument();
  });

  it("denies a request directly from the inbox list", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Deny rm -rf dist" }));

    await waitFor(() => {
      expect(screen.queryByText("rm -rf dist")).not.toBeInTheDocument();
    });
    expect(screen.getByText(/1 pending approval\b/)).toBeInTheDocument();
  });

  it("opens a full-screen expanded view and can approve from there", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: "Open approval for gh pr merge 42 --squash --delete-branch",
      }),
    );

    expect(screen.getByText(/Approve the action/)).toBeInTheDocument();
    expect(screen.getByText("GitHub write")).toBeInTheDocument();
    expect(screen.getByText("/workspace/acme-api")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow once" }));

    await waitFor(() => {
      expect(screen.getByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
    });
    expect(screen.queryByText("gh pr merge 42 --squash --delete-branch")).not.toBeInTheDocument();
  });

  it("returns to the inbox from the expanded view via the back control", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Open approval for rm -rf dist" }));
    expect(screen.getByText("Show full script")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /All approvals/ }));

    expect(await screen.findByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
  });

  it("shows the empty state once every request is decided", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", {
        name: "Deny gh pr merge 42 --squash --delete-branch",
      }),
    );
    await user.click(await screen.findByRole("button", { name: "Deny rm -rf dist" }));

    await waitFor(() => {
      expect(screen.getByText("No pending approvals")).toBeInTheDocument();
    });
  });
});
