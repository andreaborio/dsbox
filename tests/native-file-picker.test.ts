import { describe, expect, it, vi } from "vitest";
import { chooseGgufFileInFinder, finderGgufPickerScript } from "../server/native-file-picker.js";

describe("native GGUF file picker", () => {
  it("invokes a static osascript command and returns Finder's selected path", async () => {
    const runner = vi.fn(async () => ({ stdout: "/Users/alice/My Models/model.gguf\n", stderr: "" }));

    await expect(chooseGgufFileInFinder(runner, "darwin")).resolves.toBe("/Users/alice/My Models/model.gguf");
    expect(runner).toHaveBeenCalledWith("/usr/bin/osascript", ["-e", finderGgufPickerScript]);
    expect(finderGgufPickerScript).toContain("Choose a .gguf model file");
    expect(finderGgufPickerScript).not.toContain("of type");
  });

  it("treats Finder cancellation as a clean empty result", async () => {
    const runner = vi.fn(async () => {
      const error = Object.assign(new Error("execution error: User canceled. (-128)"), {
        stderr: "execution error: User canceled. (-128)"
      });
      throw error;
    });

    await expect(chooseGgufFileInFinder(runner, "darwin")).resolves.toBeNull();
  });

  it("rejects unsupported platforms without invoking a command", async () => {
    const runner = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(chooseGgufFileInFinder(runner, "linux")).rejects.toThrow(/macOS only/);
    expect(runner).not.toHaveBeenCalled();
  });
});
