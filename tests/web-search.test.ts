import { describe, expect, it, vi } from "vitest";
import { parseDuckDuckGoResults, searchWeb } from "../server/web-search.js";

describe("web search skill", () => {
  it("extracts, de-duplicates, and resolves DuckDuckGo result links", () => {
    const html = `
      <a rel="nofollow" class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Example &amp; guide</a>
      <td class="result-snippet">A concise <b>reference</b> result.</td>
      <a class="result__a" href="https://example.org/docs">Official docs</a>
      <div class="result__snippet">Primary documentation.</div>
      <a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide">Duplicate</a>
    `;
    expect(parseDuckDuckGoResults(html)).toEqual([
      { title: "Example & guide", url: "https://example.com/guide", snippet: "A concise reference result." },
      { title: "Official docs", url: "https://example.org/docs", snippet: "Primary documentation." }
    ]);
  });

  it("returns a structured provider response without contacting the network in tests", async () => {
    const fetcher = vi.fn(async () => new Response(
      '<a class="result-link" href="https://example.com">Example</a><td class="result-snippet">Result</td>',
      { status: 200 }
    ));
    const result = await searchWeb("  current   example  ", fetcher);
    expect(result.query).toBe("current example");
    expect(result.provider).toBe("DuckDuckGo");
    expect(result.results[0]).toMatchObject({ title: "Example", url: "https://example.com/" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
