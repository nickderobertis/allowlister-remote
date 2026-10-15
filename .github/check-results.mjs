const {
  SETUP_RESULT,
  CHECK_RESULT,
  MACOS_REQUIRED,
  MACOS_REASON,
  EVENT_NAME,
  OS_MATRIX,
  DIAGNOSTIC,
} = process.env;
if (
  typeof EVENT_NAME !== "string" ||
  !["pull_request", "push", "workflow_dispatch"].includes(EVENT_NAME)
)
  throw new Error("Unknown or missing EVENT_NAME; cannot authorize Mac omission");
if (SETUP_RESULT !== "success" || CHECK_RESULT !== "success")
  throw new Error("Required setup or check work failed, was cancelled, or is missing");
if (EVENT_NAME !== "pull_request" && MACOS_REQUIRED !== "false")
  throw new Error("Missing non-PR classifier authorization");
// llmlint: ignore[boundary_inputs_validated] DIAGNOSTIC is supplied by GitHub's boolean workflow_dispatch input; only literal true opts into the manual Mac lane.
const diagnostic = EVENT_NAME === "workflow_dispatch" && DIAGNOSTIC === "true";
const expected =
  EVENT_NAME === "pull_request"
    ? MACOS_REQUIRED === "true"
      ? ["ubuntu-latest", "macos-14"]
      : MACOS_REQUIRED === "false"
        ? ["ubuntu-latest"]
        : null
    : diagnostic
      ? ["ubuntu-latest", "macos-14", "windows-latest"]
      : ["ubuntu-latest", "windows-latest"];
if (
  typeof OS_MATRIX !== "string" ||
  !expected ||
  JSON.stringify(JSON.parse(OS_MATRIX)) !== JSON.stringify(expected)
)
  throw new Error("Mac omission is not authorized by classification");
console.log(
  `Required proofs succeeded on: ${expected.join(", ")}${expected.includes("macos-14") ? "" : `; Mac lane intentionally omitted by policy (${MACOS_REASON || "no classifier reason"})`}`,
);
