import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import App from "./App";

function setDesktop(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function focusedHeadline(): string | null {
  return document.querySelector('[aria-current="true"]')?.textContent ?? null;
}

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

    expect(screen.getByText("Approve shell command")).toBeInTheDocument();

    // Only the two tripping fragments appear under "needs your attention".
    const flagged = screen.getByLabelText("Flagged commands");
    expect(within(flagged).getByText("npm publish --access public")).toBeInTheDocument();
    expect(within(flagged).getByText("git push origin main --tags")).toBeInTheDocument();
    expect(within(flagged).queryByText("npm ci")).not.toBeInTheDocument();
    expect(within(flagged).getByText("ask before publishing a package")).toBeInTheDocument();
    expect(screen.getByText("/workspace/acme-api")).toBeInTheDocument();
    // The Context card surfaces the harness session id (protocol v3).
    expect(screen.getByText("9f3c1a2b7e4d")).toBeInTheDocument();

    // The interactive script lists every fragment in order, colored by permission.
    const script = screen.getByLabelText("Script");
    expect(within(script).getByText("set -euo pipefail")).toBeInTheDocument();
    expect(within(script).getByText('echo "release complete"')).toBeInTheDocument();

    // Clicking a fragment reveals that fragment's details (role, rule, reason).
    await user.click(within(script).getByRole("button", { name: /npm publish --access public/ }));
    expect(within(script).getByText(/needs approval per rule/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => {
      expect(screen.getByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
    });
  });

  it("renders 'no session' when the harness did not supply a session id", async () => {
    const user = userEvent.setup();
    render(<App />);

    // The one-off request comes from a harness (codex) with no session id.
    await user.click(
      await screen.findByRole("button", {
        name: "Open approval for gh pr merge 42 --squash --delete-branch",
      }),
    );

    expect(screen.getByText("Approve shell command")).toBeInTheDocument();
    expect(screen.getByText("no session")).toBeInTheDocument();
  });

  it("opens a tool call and toggles between formatted and JSON views", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Open approval for mcp__github__create_issue" }),
    );

    expect(screen.getByText("Approve this tool call")).toBeInTheDocument();

    // Formatted view shows the capability and the tool's arguments.
    const formatted = screen.getByLabelText("Tool call formatted view");
    expect(within(formatted).getByText("capability: mcp")).toBeInTheDocument();
    expect(within(formatted).getByText("Production is down")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "JSON" }));
    const json = screen.getByLabelText("Tool call JSON view");
    // The JSON view shows just the arguments the agent passed.
    expect(json.textContent).toContain('"title": "Production is down"');
    expect(json.textContent).toContain('"owner": "acme"');
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

describe("App keyboard navigation (desktop)", () => {
  it("moves the inbox cursor with the up and down arrow keys", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("list", { name: "Pending approvals" });

    // The first card is the cursor by default.
    expect(focusedHeadline()).toContain("gh pr merge 42 --squash --delete-branch");

    await user.keyboard("{ArrowDown}");
    expect(focusedHeadline()).toContain("npm publish --access public");

    await user.keyboard("{ArrowDown}");
    expect(focusedHeadline()).toContain("mcp__github__create_issue");

    await user.keyboard("{ArrowUp}");
    expect(focusedHeadline()).toContain("npm publish --access public");

    await user.keyboard("{ArrowUp}");
    expect(focusedHeadline()).toContain("gh pr merge 42 --squash --delete-branch");
  });

  it("opens the focused approval with Enter and returns with Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("list", { name: "Pending approvals" });

    await user.keyboard("{Enter}");
    expect(screen.getByText("Approve shell command")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(await screen.findByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
  });

  it("allows the focused approval with the A key", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("list", { name: "Pending approvals" });

    await user.keyboard("a");

    await waitFor(() => {
      expect(screen.getByText(/3 pending approvals/)).toBeInTheDocument();
    });
    expect(screen.queryByText("gh pr merge 42 --squash --delete-branch")).not.toBeInTheDocument();
  });

  it("denies the focused approval with the D key", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("list", { name: "Pending approvals" });

    await user.keyboard("{ArrowDown}");
    await user.keyboard("d");

    await waitFor(() => {
      expect(screen.getByText(/3 pending approvals/)).toBeInTheDocument();
    });
    expect(screen.queryByText("npm publish --access public")).not.toBeInTheDocument();
  });

  it("opens the shortcuts panel with ? and the floating hint, closing with Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("list", { name: "Pending approvals" });

    await user.keyboard("?");
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show keyboard shortcuts" }));
    expect(screen.getByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close shortcuts" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("allows and denies an open approval from the detail view", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Open approval for mcp__github__create_issue" }),
    );
    expect(screen.getByText("Approve this tool call")).toBeInTheDocument();

    await user.keyboard("a");
    await waitFor(() => {
      expect(screen.getByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
    });
    expect(screen.queryByText("mcp__github__create_issue")).not.toBeInTheDocument();
  });

  it("toggles the tool detail view with the F and J keys", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Open approval for mcp__github__create_issue" }),
    );
    expect(screen.getByLabelText("Tool call formatted view")).toBeInTheDocument();

    await user.keyboard("j");
    expect(screen.getByLabelText("Tool call JSON view")).toBeInTheDocument();

    await user.keyboard("f");
    expect(screen.getByLabelText("Tool call formatted view")).toBeInTheDocument();
  });

  it("reveals a script fragment's details when it is clicked", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(
      await screen.findByRole("button", { name: "Open approval for npm publish --access public" }),
    );
    const script = screen.getByLabelText("Script");
    const fragment = within(script).getByRole("button", {
      name: /git push origin main --tags/,
    });
    expect(fragment).toHaveAttribute("aria-expanded", "false");

    await user.click(fragment);
    expect(fragment).toHaveAttribute("aria-expanded", "true");
    expect(within(script).getByText("ask before pushing to a remote")).toBeInTheDocument();

    await user.click(fragment);
    expect(fragment).toHaveAttribute("aria-expanded", "false");
  });

  it("focuses a card on hover so the keyboard acts on it", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.hover(
      await screen.findByRole("button", { name: "Open approval for mcp__github__create_issue" }),
    );
    expect(focusedHeadline()).toContain("mcp__github__create_issue");
  });

  it("ignores shortcuts while focus sits on a control or a modifier is held", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("list", { name: "Pending approvals" });

    // Focus an action button: navigation keys must not hijack native behavior.
    screen.getByRole("button", { name: "Allow gh pr merge 42 --squash --delete-branch" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(focusedHeadline()).toContain("gh pr merge 42 --squash --delete-branch");

    // Modifier combos are left for the browser.
    document.body.focus();
    await user.keyboard("{Control>}a{/Control}");
    expect(screen.getByText(/4 pending approvals/)).toBeInTheDocument();
  });
});

describe("App keyboard navigation (mobile)", () => {
  it("does not bind shortcuts or render hints on touch devices", async () => {
    setDesktop(false);
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("list", { name: "Pending approvals" });

    expect(focusedHeadline()).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show keyboard shortcuts" }),
    ).not.toBeInTheDocument();

    await user.keyboard("?");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.keyboard("a");
    expect(screen.getByText(/4 pending approvals/)).toBeInTheDocument();
  });
});
