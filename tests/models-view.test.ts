import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Models view presentation", () => {
  it("keeps discovery cards simple and avoids nested stat boxes", () => {
    const view = readFileSync(new URL("../src/views/ModelsView.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");

    expect(view).toContain("catalog-card__detail-row");
    expect(view).not.toContain("On this {Math.round");
    expect(view).not.toContain("assessment.compatibility.label");
    expect(styles).toContain(".catalog-card__detail-row");
    expect(styles).not.toContain(".catalog-card__facts");
  });
});
