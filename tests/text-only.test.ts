import { describe, expect, it } from "vitest";
import { assertTextOnlyInput, UnsupportedInputModalityError } from "../server/text-only.js";

describe("text-only gateway validation", () => {
  it("accepts plain and structured text messages", () => {
    expect(() => assertTextOnlyInput({
      messages: [
        { role: "user", content: "Hello" },
        { role: "assistant", content: [{ type: "text", text: "Hi" }] }
      ]
    })).not.toThrow();
  });

  it("rejects Chat Completions image_url blocks before DS4 can ignore them", () => {
    expect(() => assertTextOnlyInput({
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Describe this" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } }
        ]
      }]
    })).toThrowError(UnsupportedInputModalityError);
  });

  it("rejects Responses and Anthropic media blocks", () => {
    expect(() => assertTextOnlyInput({
      input: [{ role: "user", content: [{ type: "input_audio", input_audio: { data: "abc" } }] }]
    })).toThrow(/audio input is not supported/);

    expect(() => assertTextOnlyInput({
      messages: [{ role: "user", content: [{ type: "document", source: { data: "abc" } }] }]
    })).toThrow(/file input is not supported/);
  });

  it("rejects media keys even when a client omits the part type", () => {
    expect(() => assertTextOnlyInput({
      messages: [{ role: "user", content: [{ image_url: "https://example.com/image.png" }] }]
    })).toThrow(/image input is not supported/);
  });
});
