import { describe, expect, it } from "vitest";
import { autoUiScale, effectiveUiScale } from "../src/lib/uiScale";
import { commandScore } from "../src/lib/commandScore";

describe("interface scale", () => {
  it("keeps a 24-inch 1080p screen near the previous default and grows on 1440p", () => {
    expect(autoUiScale(1920, 1040)).toBeCloseTo(1.15, 2);
    expect(autoUiScale(2560, 1400)).toBe(1.5);
  });
  it("never shrinks a small laptop below 90%", () => {
    expect(autoUiScale(1280, 680)).toBe(0.9);
  });
  it("uses a fixed scale when one is chosen", () => {
    expect(effectiveUiScale(1.2, 3840, 2100)).toBe(1.2);
    expect(effectiveUiScale(0, 1600, 920)).toBe(1);
  });
});

describe("command palette ranking", () => {
  it("prefers prefixes and word starts over loose matches", () => {
    expect(commandScore("Логи", "лог")).toBeGreaterThan(commandScore("Журнал: Каталог", "лог"));
    expect(commandScore("Stop: Server 1", "server")).toBeGreaterThan(0);
  });
  it("rejects scattered letters", () => {
    expect(commandScore("Сделать интерфейс компактнее", "стоп")).toBe(-1);
    expect(commandScore("Anything", "")).toBe(0);
  });
});
