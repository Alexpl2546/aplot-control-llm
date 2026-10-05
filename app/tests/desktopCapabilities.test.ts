import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Tauri desktop permissions", () => {
  it("allows the frontend to create tray icons and their menus", () => {
    const capability = JSON.parse(readFileSync("src-tauri/capabilities/default.json", "utf8")) as { permissions: string[] };
    expect(capability.permissions).toContain("core:tray:default");
    expect(capability.permissions).toContain("core:menu:default");
  });
});
