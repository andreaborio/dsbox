import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const screenshots = [
  "01-chat.png",
  "02-models.png",
  "03-server.png",
  "05-agents.png",
  "06-activity.png",
  "07-themes.png"
];

describe("documentation screenshot contract", () => {
  for (const screenshot of screenshots) {
    it(`${screenshot} is a 1280x720 PNG`, async () => {
      const image = await readFile(path.join(repositoryRoot, "docs", "media", screenshot));

      expect(image.subarray(0, 8)).toEqual(pngSignature);
      expect(image.readUInt32BE(8)).toBe(13);
      expect(image.toString("ascii", 12, 16)).toBe("IHDR");
      expect([image.readUInt32BE(16), image.readUInt32BE(20)]).toEqual([1280, 720]);
    });
  }
});
