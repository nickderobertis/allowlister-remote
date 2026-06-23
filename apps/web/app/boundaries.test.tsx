import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import ErrorBoundary from "./error";
import GlobalError from "./global-error";
import NotFound from "./not-found";

describe("app boundaries", () => {
  it("error boundary shows a retry that calls reset", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    render(<ErrorBoundary error={new Error("boom")} reset={reset} />);
    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it("not-found boundary is informational with no retry", () => {
    render(<NotFound />);
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("global-error boundary renders a fatal message and retry", async () => {
    const reset = vi.fn();
    const user = userEvent.setup();
    // global-error renders its own <html>/<body>; jsdom tolerates the nesting.
    render(<GlobalError error={new Error("fatal")} reset={reset} />);
    expect(screen.getByText("allowlister remote could not start")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(reset).toHaveBeenCalledOnce();
  });
});
