import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useFocusTrap } from "./focus-trap";

function Harness({ active, empty = false }: { active: boolean; empty?: boolean }) {
  const ref = useFocusTrap<HTMLDivElement>(active);
  return (
    <div>
      <button type="button">outside</button>
      {active ? (
        <div ref={ref} data-testid="trap">
          {empty ? null : (
            <>
              <button type="button">first</button>
              <button type="button">middle</button>
              <button type="button">last</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

describe("useFocusTrap", () => {
  it("moves focus into the container when it activates", () => {
    const { rerender } = render(<Harness active={false} />);
    screen.getByText("outside").focus();
    rerender(<Harness active={true} />);
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Tab from the last element back to the first", () => {
    render(<Harness active={true} />);
    screen.getByText("last").focus();
    fireEvent.keyDown(screen.getByTestId("trap"), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("wraps Shift+Tab from the first element to the last", () => {
    render(<Harness active={true} />);
    screen.getByText("first").focus();
    fireEvent.keyDown(screen.getByTestId("trap"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByText("last"));
  });

  it("leaves non-Tab keys and interior tab stops alone", () => {
    render(<Harness active={true} />);
    screen.getByText("first").focus();
    // A non-Tab key is ignored entirely.
    fireEvent.keyDown(screen.getByTestId("trap"), { key: "a" });
    expect(document.activeElement).toBe(screen.getByText("first"));
    // Tab away from a boundary is left to the browser (focus is unchanged here
    // because jsdom does not advance focus on its own).
    fireEvent.keyDown(screen.getByTestId("trap"), { key: "Tab" });
    expect(document.activeElement).toBe(screen.getByText("first"));
  });

  it("no-ops when the container has no focusable children", () => {
    render(<Harness active={true} empty />);
    expect(() => fireEvent.keyDown(screen.getByTestId("trap"), { key: "Tab" })).not.toThrow();
  });

  it("restores focus to the prior element when it deactivates", () => {
    const { rerender } = render(<Harness active={false} />);
    screen.getByText("outside").focus();
    rerender(<Harness active={true} />);
    rerender(<Harness active={false} />);
    expect(document.activeElement).toBe(screen.getByText("outside"));
  });
});
