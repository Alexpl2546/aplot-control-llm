import { describe, expect, it } from "vitest";
import { validateConfig } from "../src/lib/validation";
import { TEST_CONFIG } from "./fixtures";
describe("configuration validation",()=>{it("accepts a complete launch config without hard errors",()=>{expect(validateConfig(TEST_CONFIG).filter(x=>x.severity==="error")).toHaveLength(0)});it("warns about public binding without API key",()=>{const issues=validateConfig({...TEST_CONFIG,host:"0.0.0.0",apiKey:""});expect(issues.some(x=>x.field==="host"&&x.severity==="warning")).toBe(true)});});
