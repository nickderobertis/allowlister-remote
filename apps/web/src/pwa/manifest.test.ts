import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The Vitest target runs with apps/web as its working directory.
const publicDir = `${resolve(process.cwd(), "public")}/`;

function readManifest() {
  return JSON.parse(readFileSync(`${publicDir}manifest.webmanifest`, "utf8"));
}

describe("web app manifest", () => {
  it("declares the core installability metadata", () => {
    const manifest = readManifest();
    expect(manifest.name).toBeTruthy();
    expect(manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.theme_color).toMatch(/^#/);
    expect(manifest.background_color).toMatch(/^#/);
  });

  it("ships maskable PNG icons at the installable sizes", () => {
    const manifest = readManifest();
    const icons: Array<{ src: string; sizes: string; type: string; purpose?: string }> =
      manifest.icons;

    const png = (size: string) =>
      icons.find((icon) => icon.type === "image/png" && icon.sizes === size);

    expect(png("192x192"), "expected a 192x192 PNG icon").toBeTruthy();
    expect(png("512x512"), "expected a 512x512 PNG icon").toBeTruthy();
    expect(
      icons.some((icon) => (icon.purpose ?? "").split(" ").includes("maskable")),
      "expected at least one maskable icon",
    ).toBe(true);
  });

  it("references icon assets that exist on disk", () => {
    const manifest = readManifest();
    const sources: string[] = manifest.icons.map((icon: { src: string }) => icon.src);
    // Apple devices ignore the manifest and require a dedicated touch icon.
    sources.push("/apple-touch-icon.png");

    for (const src of sources) {
      const onDisk = `${publicDir}${src.replace(/^\//, "")}`;
      expect(existsSync(onDisk), `missing asset ${src}`).toBe(true);
    }
  });
});
