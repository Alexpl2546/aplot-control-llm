import { describe, expect, it } from "vitest";
import { classifyError } from "../src/lib/errors";

describe("friendly error classifier", () => {
  it("recognizes missing binary errors", () => {
    expect(classifyError("ENOENT: llama-server.exe not found").titleKey).toBe("error.binaryTitle");
  });
  it("recognizes port conflicts", () => {
    expect(classifyError("Address already in use (os error 10048)").titleKey).toBe("error.portTitle");
  });
  it("recognizes permission and timeout errors", () => {
    expect(classifyError("Access is denied (os error 5)").titleKey).toBe("error.permissionTitle");
    expect(classifyError("request timed out").titleKey).toBe("error.timeoutTitle");
  });
  it("recognizes invalid profile errors", () => {
    expect(classifyError("Invalid profile ‘large-context’: unsupported flag").titleKey).toBe("error.profileTitle");
  });
  it("preserves technical details", () => {
    const raw = "some unexpected low-level failure";
    expect(classifyError(raw).technical).toBe(raw);
  });
});
