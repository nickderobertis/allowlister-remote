import { resetCaptureRoot } from "./capture-index";

// Clear the capture root once before the run so captures.json and its PNGs are
// rebuilt from scratch every time (screencomp's reproducibility gate compares
// content, and a stale index would leak shots that are no longer captured).
export default async function globalSetup(): Promise<void> {
  await resetCaptureRoot();
}
