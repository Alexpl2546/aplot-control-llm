import { describe, expect, it } from "vitest";
import en from "../src/locales/en/common.json";
import ru from "../src/locales/ru/common.json";
describe("localization",()=>{it("keeps EN/RU key parity",()=>{expect(Object.keys(en).sort()).toEqual(Object.keys(ru).sort())});});
