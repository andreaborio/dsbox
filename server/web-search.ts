const SEARCH_ENDPOINT = "https://lite.duckduckgo.com/lite/";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  query: string;
  provider: "DuckDuckGo";
  results: WebSearchResult[];
  searchedAt: string;
}

type SearchFetcher = (input: string, init: RequestInit) => Promise<Response>;

function decodeHtml(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_match, entity: string) => named[entity.toLowerCase()] ?? `&${entity};`)
    .replace(/\s+/g, " ")
    .trim();
}

function resolveResultUrl(value: string): string | null {
  const decoded = decodeHtml(value);
  try {
    const url = new URL(decoded.startsWith("//") ? `https:${decoded}` : decoded, "https://duckduckgo.com");
    const redirected = url.searchParams.get("uddg");
    const result = redirected ? new URL(redirected) : url;
    if (!["http:", "https:"].includes(result.protocol)) return null;
    if (result.hostname.endsWith("duckduckgo.com") && !redirected) return null;
    return result.toString();
  } catch {
    return null;
  }
}

export function parseDuckDuckGoResults(html: string, limit = 6): WebSearchResult[] {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)];
  const results: WebSearchResult[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < anchors.length && results.length < limit; index += 1) {
    const match = anchors[index];
    const attributes = match[1];
    if (!/class\s*=\s*["'][^"']*(?:result-link|result__a)[^"']*["']/i.test(attributes)) continue;
    const href = attributes.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    const url = resolveResultUrl(href);
    if (!url || seen.has(url)) continue;
    const title = decodeHtml(match[2]);
    if (!title) continue;
    const currentEnd = (match.index ?? 0) + match[0].length;
    const nextStart = anchors[index + 1]?.index ?? html.length;
    const nearby = html.slice(currentEnd, Math.min(nextStart, currentEnd + 2500));
    const snippetMatch = nearby.match(/<(?:td|div)[^>]*class\s*=\s*["'][^"']*(?:result-snippet|result__snippet)[^"']*["'][^>]*>([\s\S]*?)<\/(?:td|div)>/i);
    results.push({ title, url, snippet: snippetMatch ? decodeHtml(snippetMatch[1]) : "" });
    seen.add(url);
  }
  return results;
}

export async function searchWeb(query: string, fetcher: SearchFetcher = globalThis.fetch, externalSignal?: AbortSignal): Promise<WebSearchResponse> {
  const normalized = query.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!normalized) throw new Error("Enter a search query");
  const body = new URLSearchParams({ q: normalized });
  const response = await fetcher(SEARCH_ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Hebrus-Studio/0.3 local web search"
    },
    body: body.toString(),
    signal: externalSignal ? AbortSignal.any([externalSignal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000)
  });
  if (!response.ok) throw new Error(`Web search provider returned ${response.status}`);
  const results = parseDuckDuckGoResults(await response.text());
  if (!results.length) throw new Error("No web results were returned");
  return { query: normalized, provider: "DuckDuckGo", results, searchedAt: new Date().toISOString() };
}
