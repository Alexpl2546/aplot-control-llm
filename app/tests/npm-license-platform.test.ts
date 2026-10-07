import { describe, expect, it } from "vitest";
import { supportsPlatform } from "../scripts/npm-license-platform.mjs";

describe("npm license platform selection", () => {
  it("includes unrestricted packages and the installed Windows compiler", () => {
    expect(supportsPlatform({}, "win32", "x64")).toBe(true);
    expect(supportsPlatform({ os: ["win32"], cpu: ["x64"] }, "win32", "x64")).toBe(true);
  });

  it("excludes binaries for another OS or architecture", () => {
    expect(supportsPlatform({ os: ["aix"], cpu: ["ppc64"] }, "win32", "x64")).toBe(false);
    expect(supportsPlatform({ os: ["win32"], cpu: ["arm64"] }, "win32", "x64")).toBe(false);
    expect(supportsPlatform({ os: ["linux"], cpu: ["x64"] }, "linux", "x64")).toBe(true);
  });

  it("honors npm allowlists, exclusions and the any wildcard", () => {
    expect(supportsPlatform({ os: ["!linux"] }, "win32", "x64")).toBe(true);
    expect(supportsPlatform({ os: ["!win32"] }, "win32", "x64")).toBe(false);
    expect(supportsPlatform({ os: ["linux", "darwin"] }, "win32", "x64")).toBe(false);
    expect(supportsPlatform({ cpu: ["any", "!arm64"] }, "win32", "x64")).toBe(true);
    expect(supportsPlatform({ cpu: ["any", "!arm64"] }, "win32", "arm64")).toBe(false);
  });
});
