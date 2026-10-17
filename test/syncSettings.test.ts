import { describe, expect, it } from "vitest";
import { normalizeDesktopAddress } from "../src/core/api.ts";

describe("desktop address", () => {
  it("adds http:// when the scheme is left out and drops trailing slashes", () => {
    expect(normalizeDesktopAddress(" 192.168.86.249:5180/ ")).toBe("http://192.168.86.249:5180");
    expect(normalizeDesktopAddress("http://192.168.86.249:5180")).toBe("http://192.168.86.249:5180");
    expect(normalizeDesktopAddress("HTTP://host:5180//")).toBe("HTTP://host:5180");
    expect(normalizeDesktopAddress("")).toBe("");
  });
});
