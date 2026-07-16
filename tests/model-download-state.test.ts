import { describe, expect, it } from "vitest";
import { shouldRevealActiveDownload } from "../src/lib/model-download-state.js";

describe("model download visibility", () => {
  it("reveals a download when it becomes active", () => {
    expect(shouldRevealActiveDownload(null, "download-1")).toBe(true);
  });

  it("does not keep scrolling for progress updates from the same download", () => {
    expect(shouldRevealActiveDownload("download-1", "download-1")).toBe(false);
  });

  it("reveals the same download again after it was paused", () => {
    expect(shouldRevealActiveDownload(null, "download-1")).toBe(true);
  });

  it("does nothing when there is no active download", () => {
    expect(shouldRevealActiveDownload("download-1", null)).toBe(false);
  });
});
