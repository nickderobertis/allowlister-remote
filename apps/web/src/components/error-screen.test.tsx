import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ErrorScreen } from "./error-screen";

describe("ErrorScreen", () => {
  it("renders the title and description as an alert", () => {
    render(<ErrorScreen title="Boom" description="It broke." />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Boom");
    expect(alert).toHaveTextContent("It broke.");
    // No retry affordance unless one is wired up.
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();
  });

  it("invokes onRetry when the retry button is pressed", async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    render(<ErrorScreen title="Boom" description="It broke." onRetry={onRetry} />);
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
