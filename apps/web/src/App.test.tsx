import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import App from "./App";

describe("App", () => {
  it("shows the important allowlister command before the full script", async () => {
    render(<App />);

    expect(await screen.findAllByText("gh pr merge 42 --squash --delete-branch")).toHaveLength(3);
    expect(screen.getByText(/Approve the action/)).toBeInTheDocument();
    expect(screen.getByText("GitHub write")).toBeInTheDocument();
  });

  it("lets the user deny a pending request", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Deny" }));

    await waitFor(() => {
      expect(screen.getByText("No pending approvals")).toBeInTheDocument();
    });
  });
});

it("lets the user allow a pending request", async () => {
  const user = userEvent.setup();
  render(<App />);

  await user.click(await screen.findByRole("button", { name: "Allow once" }));

  await waitFor(() => {
    expect(screen.getByText("No pending approvals")).toBeInTheDocument();
  });
});
