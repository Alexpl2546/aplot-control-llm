import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync("src-tauri/src/web_ui_bootstrap.js", "utf8");
const strataSource = readFileSync("src-tauri/src/strata_web_ui_bootstrap.js", "utf8");
function initialize(origin: string, key: string, saved: Record<string, string> = {}, actualOrigin = origin, childFrame = false, script = source) {
  const records = new Map(Object.entries(saved));
  const window = { top: null as unknown };
  window.top = childFrame ? {} : window;
  runInNewContext(`(${script})(${JSON.stringify(origin)}, ${JSON.stringify(key)})`, {
    window, location: { origin: actualOrigin },
    localStorage: { getItem: (name: string) => records.get(name) ?? null, setItem: (name: string, value: string) => records.set(name, value) },
    sessionStorage: { setItem: (name: string, value: string) => records.set(`session:${name}`, value) },
  });
  return records;
}

describe("native Web UI authentication bootstrap", () => {
  it("keeps simultaneous ports and credentials isolated while preserving UI preferences", () => {
    const first = initialize("http://127.0.0.1:8080", "first-key", { "LlamaUi.config": '{"theme":"dark","temperature":0.7}' });
    const second = initialize("http://127.0.0.1:8081", 'second-"key\\\n');
    expect(JSON.parse(first.get("LlamaUi.config")!)).toEqual({ theme: "dark", temperature: 0.7, apiKey: "first-key" });
    expect(JSON.parse(second.get("LlamaUi.config")!).apiKey).toBe('second-"key\\\n');
  });
  it("clears an old key when a port is reused for a server without authentication", () => {
    const result = initialize("http://127.0.0.1:8080", "", { "LlamaUi.config": '{"apiKey":"old-key","theme":"light"}' });
    expect(JSON.parse(result.get("LlamaUi.config")!)).toEqual({ apiKey: "", theme: "light" });
  });
  it("recovers damaged settings from a valid legacy record", () => {
    const result = initialize("http://127.0.0.1:8080", "new-key", { "LlamaUi.config": "{broken", "LlamaCppWebui.config": '{"theme":"dark","apiKey":"stale"}' });
    expect(JSON.parse(result.get("LlamaUi.config")!)).toEqual({ theme: "dark", apiKey: "new-key" });
  });
  it("does not seed keys into another origin or child frames", () => {
    expect(initialize("http://127.0.0.1:8080", "private", {}, "http://127.0.0.1:8081").size).toBe(0);
    expect(initialize("http://127.0.0.1:8080", "private", {}, "http://127.0.0.1:8080", true).size).toBe(0);
  });
});

describe("Strata Web UI authentication", () => {
  it("uses Strata's own storage without overwriting chats, preferences or llama.cpp settings", () => {
    const saved = { "strata.theme": "dark", "strata.chats": '[{"title":"Keep me"}]', "LlamaUi.config": '{"apiKey":"llama"}' };
    const first = initialize("http://127.0.0.1:8080", 'first-"key\\\n', saved, undefined, false, strataSource);
    const second = initialize("http://127.0.0.1:8081", "second-key", {}, undefined, false, strataSource);
    expect(JSON.parse(first.get("strata.apikey")!)).toBe('first-"key\\\n');
    expect(first.get("session:strata.monitor.key")).toBe('first-"key\\\n');
    expect(JSON.parse(second.get("strata.apikey")!)).toBe("second-key");
    for (const [name, value] of Object.entries(saved)) expect(first.get(name)).toBe(value);
  });
  it("clears stale authentication after reusing a port for a keyless server", () => {
    const records = initialize("http://127.0.0.1:8080", "", { "strata.apikey": '"old-key"' }, undefined, false, strataSource);
    expect(JSON.parse(records.get("strata.apikey")!)).toBe("");
    expect(records.get("session:strata.monitor.key")).toBe("");
  });
  it("does not expose credentials to other origins or nested frames", () => {
    expect(initialize("http://127.0.0.1:8080", "private", {}, "http://127.0.0.1:8081", false, strataSource).size).toBe(0);
    expect(initialize("http://127.0.0.1:8080", "private", {}, undefined, true, strataSource).size).toBe(0);
  });
});
