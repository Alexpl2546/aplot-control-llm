import { describe, expect, it } from "vitest";
import { DEFAULT_DASHBOARD_WIDGETS, type DashboardRect } from "../src/types/app";
import { defaultDashboardLayout, moveDashboardTile, normalizeDashboardLayout, overlaps, projectDashboardLayout, resizeDashboardTile, resolveDashboardCollisions, saveDashboardRects } from "../src/lib/dashboardLayout";

const a: DashboardRect = { x: 0, y: 0, w: 240, h: 180 };
const b: DashboardRect = { x: 254, y: 0, w: 240, h: 180 };

describe("modular dashboard", () => {
  it("creates a non-overlapping default and projects into a narrower field", () => {
    for (const width of [350, 700, 1000, 1800, 2400]) {
      for (const saved of [null, defaultDashboardLayout(DEFAULT_DASHBOARD_WIDGETS)]) {
      const rects = Object.values(projectDashboardLayout(saved, DEFAULT_DASHBOARD_WIDGETS, width));
      expect(rects).toHaveLength(15);
      rects.forEach((r, index) => {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(width + .1);
        expect(r.y).toBeGreaterThanOrEqual(0);
        rects.slice(index + 1).forEach(other => expect(overlaps(r, other)).toBe(false));
      });
      }
    }
  });
  it("keeps free positions, snaps to neighbors and both field sides, and allows Alt precision", () => {
    expect(moveDashboardTile(a, 69, 87, [], 900, 600).rect).toMatchObject({ x: 69, y: 87 });
    expect(moveDashboardTile(a, 250, 0, [b], 900, 600).rect.x).toBe(254);
    expect(moveDashboardTile(a, 658, 0, [], 900, 600).rect.x).toBe(660);
    expect(moveDashboardTile({ ...a, x: 50 }, -47, 418, [], 900, 600).rect).toMatchObject({ x: 0, y: 420 });
    expect(moveDashboardTile(a, 250, 0, [b], 900, 600, false).rect.x).toBe(250);
  });
  it("resizes from all sides, respecting minimums and field boundaries", () => {
    const r = { ...a, x: 100, y: 100, w: 400, h: 300 };
    const minimum = { w: 180, h: 145 };
    expect(resizeDashboardTile(r, "nw", -300, -300, [], 900, minimum).rect).toEqual({ x: 0, y: 0, w: 500, h: 400 });
    expect(resizeDashboardTile(r, "se", 999, -999, [], 900, minimum).rect).toEqual({ x: 100, y: 100, w: 800, h: 145 });
    expect(resizeDashboardTile(r, "w", 999, 0, [], 900, minimum).rect).toMatchObject({ x: 320, w: 180 });
    expect(resizeDashboardTile(r, "n", 0, 999, [], 900, minimum).rect).toMatchObject({ y: 255, h: 145 });
    expect(resizeDashboardTile(a, "e", 4, 0, [b], 900, minimum).rect.w).toBe(240);
  });
  it("preserves the moved card and shifts all colliding cards without overlap", () => {
    const result = resolveDashboardCollisions({ "hardware.gpu": { ...a, x: 200 }, "hardware.cpu": b, "hardware.memory": { ...b, y: 194 } }, "hardware.gpu");
    expect(result["hardware.gpu"]).toEqual({ ...a, x: 200 });
    expect(result["hardware.cpu"]!.y).toBe(194);
    expect(result["hardware.memory"]!.y).toBe(388);
  });
  it("roundtrips arbitrary sizes and positions and preserves hidden cards", () => {
    const original = { version: 1 as const, items: { "hardware.cpu": b } };
    const rects = { "hardware.gpu": { ...a, x: 25.5, y: 76.25, w: 301.5, h: 250 } };
    const saved = saveDashboardRects(rects, 1000, original);
    expect(saved.items["hardware.cpu"]).toEqual(b);
    expect(projectDashboardLayout(saved, ["hardware.gpu"], 1000)["hardware.gpu"]).toEqual(rects["hardware.gpu"]);
  });
  it("ignores unsupported/corrupt layouts and bounds individual rectangles", () => {
    expect(normalizeDashboardLayout({ version: 2, items: {} })).toBeNull();
    expect(normalizeDashboardLayout({ version: 1, items: { "hardware.gpu": { ...a, w: NaN } } })!.items).toEqual({});
    expect(normalizeDashboardLayout({ version: 1, items: { "hardware.gpu": { x: -30, y: -10, w: 2000, h: 1 }, alien: a } })!.items).toEqual({ "hardware.gpu": { x: 0, y: 0, w: 1200, h: 180 } });
  });
});
