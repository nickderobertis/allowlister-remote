import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "./App";
import { brokerRequestPayloads } from "./test/broker-fixtures";

// The broker bridge is the app's only source of requests, so the unit tests
// drive it directly: connectBroker is mocked to capture the handlers App
// registers (so a test can push a snapshot / added / resolved event) and to
// record the decisions App sends back. /api/config and navigator.serviceWorker
// are stubbed so the connect effect runs under jsdom.
type BrokerHandlers = {
  onSnapshot?: (requests: unknown[]) => void;
  onAdded?: (request: unknown) => void;
  onResolved?: (requestId: string) => void;
  onStatus?: (status: string) => void;
};

const broker = vi.hoisted(() => ({
  handlers: null as BrokerHandlers | null,
  url: null as string | null,
  decisions: [] as { requestId: string; verdict: string; reason: string }[],
  closed: false,
}));

vi.mock("./pwa/broker-bridge", () => ({
  connectBroker: (url: string, handlers: BrokerHandlers) => {
    broker.url = url;
    broker.handlers = handlers;
    return {
      decide: (decision: { requestId: string; verdict: string; reason: string }) =>
        broker.decisions.push(decision),
      close: () => {
        broker.closed = true;
      },
    };
  },
}));

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

function setServiceWorker(present: boolean) {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: present
      ? { controller: {}, addEventListener: vi.fn(), removeEventListener: vi.fn() }
      : undefined,
  });
}

function stubConfig(response: unknown | (() => Promise<never>)) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      typeof response === "function" ? response() : ({ json: async () => response } as Response),
    ),
  );
}

function focusedHeadline(): string | null {
  return document.querySelector('[aria-current="true"]')?.textContent ?? null;
}

// Render the app, wait for the connect effect to register broker handlers, then
// push the snapshot of pending requests the way the broker would on subscribe.
async function renderApp() {
  const view = render(<App />);
  await waitFor(() => expect(broker.handlers).not.toBeNull());
  act(() => broker.handlers?.onSnapshot?.(brokerRequestPayloads));
  return view;
}

beforeEach(() => {
  broker.handlers = null;
  broker.url = null;
  broker.decisions = [];
  broker.closed = false;
  setServiceWorker(true);
  stubConfig({ brokerUrl: "ws://test/ws/pwa" });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App broker connection", () => {
  it("connects to the broker URL from /api/config and renders its snapshot", async () => {
    await renderApp();
    expect(broker.url).toBe("ws://test/ws/pwa");
    expect(await screen.findByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
  });

  it("reports an error when the browser has no service worker", async () => {
    setServiceWorker(false);
    render(<App />);
    expect(
      await screen.findByText(/no service worker, which allowlister-remote requires/),
    ).toBeInTheDocument();
    expect(broker.handlers).toBeNull();
  });

  it("reports an error when no broker is configured", async () => {
    stubConfig({ brokerUrl: null });
    render(<App />);
    expect(
      await screen.findByText("No approval broker is configured for this deployment."),
    ).toBeInTheDocument();
    expect(broker.handlers).toBeNull();
  });

  it("reports an error when the config request fails", async () => {
    stubConfig(() => Promise.reject(new Error("offline")));
    render(<App />);
    expect(
      await screen.findByText("Could not load the approval broker configuration."),
    ).toBeInTheDocument();
    expect(broker.handlers).toBeNull();
  });

  it("adds a newly announced request and ignores a duplicate re-announce", async () => {
    await renderApp();
    await screen.findByRole("list", { name: "Pending approvals" });

    const added = {
      id: "demo-added",
      subject: "shell",
      command: "terraform apply",
      current_verdict: "defer",
      fragments: [{ display: "terraform apply", verdict: "ask", role: "standalone" }],
    };
    act(() => broker.handlers?.onAdded?.(added));
    expect(await screen.findByText(/5 pending approvals/)).toBeInTheDocument();

    // A re-announce of the same id (e.g. after a broker restart) must not stack.
    act(() => broker.handlers?.onAdded?.(added));
    expect(screen.getByText(/5 pending approvals/)).toBeInTheDocument();
  });

  it("removes a request when the broker resolves it elsewhere", async () => {
    await renderApp();
    await screen.findByText("gh pr merge 42 --squash --delete-branch");

    act(() => broker.handlers?.onResolved?.("demo-oneoff"));
    await waitFor(() => {
      expect(screen.getByText(/3 pending approvals/)).toBeInTheDocument();
    });
    expect(screen.queryByText("gh pr merge 42 --squash --delete-branch")).not.toBeInTheDocument();
  });

  it("sends decisions back through the broker", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(
      await screen.findByRole("button", {
        name: "Allow gh pr merge 42 --squash --delete-branch",
      }),
    );

    expect(broker.decisions).toEqual([
      {
        requestId: "demo-oneoff",
        verdict: "allow",
        reason: "allowed in allowlister-remote",
      },
    ]);
  });
});

describe("App inbox", () => {
  it("lists every pending allowlister request as an inbox entry", async () => {
    await renderApp();

    const list = await screen.findByRole("list", { name: "Pending approvals" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(within(list).getByText("gh pr merge 42 --squash --delete-branch")).toBeInTheDocument();
    // The longer script headlines on its first flagged fragment; the card shows
    // that command both as a flagged fragment and in the script, so it appears
    // more than once.
    expect(
      within(list).getAllByText("kubectl --context $region apply -f deploy/manifest.yaml").length,
    ).toBeGreaterThanOrEqual(1);
    expect(within(list).getByText("mcp__github__create_issue")).toBeInTheDocument();
    expect(screen.getByText(/4 pending approvals/)).toBeInTheDocument();
  });

  it("previews tool-call arguments on the inbox card instead of the prose reason", async () => {
    await renderApp();

    const list = await screen.findByRole("list", { name: "Pending approvals" });
    // The tool card previews the verbatim arguments the agent passed.
    expect(within(list).getByText("title = Production is down")).toBeInTheDocument();
    expect(within(list).getByText("owner = acme")).toBeInTheDocument();
    // The prose `currentReason` is dropped from the inbox; the data stands in.
    expect(
      within(list).queryByText("no rule matched tool `mcp__github__create_issue`"),
    ).not.toBeInTheDocument();
  });

  it("previews the flagged commands and the full script as separate sections", async () => {
    await renderApp();

    const list = await screen.findByRole("list", { name: "Pending approvals" });
    // Every shell card has a "Flagged" section; the multi-line script card also
    // adds a "Script" section beneath it.
    expect(within(list).getAllByText("Flagged").length).toBeGreaterThanOrEqual(1);
    expect(within(list).getByText("Script")).toBeInTheDocument();
    // The loop-body command that tripped the gate appears in both sections (as the
    // flagged action and in its place in the script), so it never looks dropped.
    expect(
      within(list).getAllByText("kubectl --context $region apply -f deploy/manifest.yaml"),
    ).toHaveLength(2);
    // The full script renders every line in place — including the `for … do`
    // header and its `done`, which a flagged-only preview would omit.
    expect(within(list).getByText("set -euo pipefail")).toBeInTheDocument();
    expect(
      within(list).getByText("for region in $(cat deploy/regions.txt); do"),
    ).toBeInTheDocument();
    expect(within(list).getByText("done")).toBeInTheDocument();
  });

  it("allows a request directly from the inbox list without opening it", async () => {
    const user = userEvent.setup();
    await renderApp();

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
    await renderApp();

    await user.click(
      await screen.findByRole("button", {
        name: "Open approval for kubectl --context $region apply -f deploy/manifest.yaml",
      }),
    );

    expect(screen.getByText("Approve shell command")).toBeInTheDocument();

    // Only the two tripping fragments appear under "needs your attention" — one of
    // them the `kubectl apply` nested inside the loop body.
    const flagged = screen.getByLabelText("Flagged commands");
    expect(
      within(flagged).getByText("kubectl --context $region apply -f deploy/manifest.yaml"),
    ).toBeInTheDocument();
    expect(within(flagged).getByText("git push origin main --tags")).toBeInTheDocument();
    expect(within(flagged).queryByText("npm run build")).not.toBeInTheDocument();
    expect(
      within(flagged).getByText("ask before applying kubernetes manifests"),
    ).toBeInTheDocument();
    expect(screen.getByText("/workspace/acme-api")).toBeInTheDocument();
    // The Context card surfaces the harness session id (protocol v3).
    expect(screen.getByText("9f3c1a2b7e4d")).toBeInTheDocument();

    // The interactive script renders the real script line by line, colored by
    // permission — including the `for … do` header and its `done`, which the flat
    // fragment list used to drop.
    const script = screen.getByLabelText("Script");
    expect(within(script).getByText("set -euo pipefail")).toBeInTheDocument();
    expect(
      within(script).getByText("for region in $(cat deploy/regions.txt); do"),
    ).toBeInTheDocument();
    expect(within(script).getByText("done")).toBeInTheDocument();
    // The indented loop-body line renders too (whitespace is normalized away by the
    // text matcher, but it confirms the loop body is in the script).
    expect(
      within(script).getByText("curl -fsS https://api.acme.dev/$region/healthz"),
    ).toBeInTheDocument();

    // Clicking a fragment reveals that fragment's details (role, rule, reason) —
    // here the `kubectl apply` nested in the loop body.
    await user.click(within(script).getByRole("button", { name: /kubectl/ }));
    expect(within(script).getByText(/needs approval per rule/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow once" }));
    await waitFor(() => {
      expect(screen.getByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
    });
  });

  it("renders 'no session' when the harness did not supply a session id", async () => {
    const user = userEvent.setup();
    await renderApp();

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
    await renderApp();

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
    // Keys and string values are syntax-highlighted into distinctly coloured runs.
    const keyToken = within(json)
      .getAllByText('"title"')
      .find((node) => node.tagName === "SPAN");
    expect(keyToken).toHaveClass("text-[var(--json-key)]");
  });

  it("returns to the inbox from the expanded view via the back control", async () => {
    const user = userEvent.setup();
    await renderApp();

    await user.click(await screen.findByRole("button", { name: "Open approval for write" }));
    expect(screen.getByText("Approve this tool call")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /All approvals/ }));

    expect(await screen.findByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
  });

  it("shows the empty state once every request is decided", async () => {
    const user = userEvent.setup();
    await renderApp();

    for (const name of [
      "Deny gh pr merge 42 --squash --delete-branch",
      "Deny kubectl --context $region apply -f deploy/manifest.yaml",
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
    await renderApp();
    await screen.findByRole("list", { name: "Pending approvals" });

    // The first card is the cursor by default.
    expect(focusedHeadline()).toContain("gh pr merge 42 --squash --delete-branch");

    await user.keyboard("{ArrowDown}");
    expect(focusedHeadline()).toContain("kubectl --context $region apply -f deploy/manifest.yaml");

    await user.keyboard("{ArrowDown}");
    expect(focusedHeadline()).toContain("mcp__github__create_issue");

    await user.keyboard("{ArrowUp}");
    expect(focusedHeadline()).toContain("kubectl --context $region apply -f deploy/manifest.yaml");

    await user.keyboard("{ArrowUp}");
    expect(focusedHeadline()).toContain("gh pr merge 42 --squash --delete-branch");
  });

  it("opens the focused approval with Enter and returns with Escape", async () => {
    const user = userEvent.setup();
    await renderApp();
    await screen.findByRole("list", { name: "Pending approvals" });

    await user.keyboard("{Enter}");
    expect(screen.getByText("Approve shell command")).toBeInTheDocument();

    await user.keyboard("{Escape}");
    expect(await screen.findByRole("list", { name: "Pending approvals" })).toBeInTheDocument();
  });

  it("allows the focused approval with the A key", async () => {
    const user = userEvent.setup();
    await renderApp();
    await screen.findByRole("list", { name: "Pending approvals" });

    await user.keyboard("a");

    await waitFor(() => {
      expect(screen.getByText(/3 pending approvals/)).toBeInTheDocument();
    });
    expect(screen.queryByText("gh pr merge 42 --squash --delete-branch")).not.toBeInTheDocument();
  });

  it("denies the focused approval with the D key", async () => {
    const user = userEvent.setup();
    await renderApp();
    await screen.findByRole("list", { name: "Pending approvals" });

    await user.keyboard("{ArrowDown}");
    await user.keyboard("d");

    await waitFor(() => {
      expect(screen.getByText(/3 pending approvals/)).toBeInTheDocument();
    });
    expect(
      screen.queryByText("kubectl --context $region apply -f deploy/manifest.yaml"),
    ).not.toBeInTheDocument();
  });

  it("opens the shortcuts panel with ? and the floating hint, closing with Escape", async () => {
    const user = userEvent.setup();
    await renderApp();
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
    await renderApp();

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
    await renderApp();

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
    await renderApp();

    await user.click(
      await screen.findByRole("button", {
        name: "Open approval for kubectl --context $region apply -f deploy/manifest.yaml",
      }),
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
    await renderApp();

    await user.hover(
      await screen.findByRole("button", { name: "Open approval for mcp__github__create_issue" }),
    );
    expect(focusedHeadline()).toContain("mcp__github__create_issue");
  });

  it("ignores shortcuts while focus sits on a control or a modifier is held", async () => {
    const user = userEvent.setup();
    await renderApp();
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
    await renderApp();
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
