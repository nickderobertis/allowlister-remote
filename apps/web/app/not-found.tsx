import { ErrorScreen } from "../src/components/error-screen";

export const metadata = {
  title: "Not found · allowlister remote",
};

// The 404 boundary. Static export renders this to 404.html; there is no in-app
// router link to follow, so it stays informational.
export default function NotFound() {
  return (
    <ErrorScreen
      title="Page not found"
      description="That page doesn't exist. Open the app at its root to see your pending approvals."
    />
  );
}
