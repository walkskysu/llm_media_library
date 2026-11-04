import { describe, expect, it } from "vitest";
import { formatDuration, normalizeDate, parseClock, parseDuration } from "../src/lib/format";

describe("parseDuration", () => {
  it.each<[unknown, number | null]>([
    [125, 125],
    ["125", 125],
    ["PT1H2M3S", 3723],
    ["PT4M", 240],
    ["P1DT1S", 86401],
    ["1:02:03", 3723],
    ["02:03", 123],
    ["abc", null],
    ["", null],
    [null, null],
    [-1, null],
    ["1:75", null],
  ])("%s → %s", (input, out) => expect(parseDuration(input)).toBe(out));
});

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(59)).toBe("0:59");
    expect(formatDuration(3723)).toBe("1:02:03");
    expect(formatDuration(null)).toBe("");
  });
  it("parses clocks", () => {
    expect(parseClock("00:16")).toBe(16);
    expect(parseClock("01:00:00")).toBe(3600);
  });
  it("normalises dates", () => {
    expect(normalizeDate("2024/3/5")).toBe("2024-03-05");
    expect(normalizeDate("2024-03-05T10:00:00Z")).toBe("2024-03-05");
    expect(normalizeDate("March 2024")).toBe("March 2024");
    expect(normalizeDate(undefined)).toBe("");
  });
});
