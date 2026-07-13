export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (path.startsWith("/api/") && !["GET", "HEAD"].includes((init?.method ?? "GET").toUpperCase())) {
    headers.set("x-dsbox-control", "1");
  }
  const response = await fetch(path, { ...init, headers });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === "object" && body && "error" in body
      ? typeof body.error === "string" ? body.error : (body.error as { message?: string })?.message
      : typeof body === "string" ? body : `Request failed (${response.status})`;
    throw new Error(message || `Request failed (${response.status})`);
  }
  return body as T;
}

export async function postAction(path: string, body?: unknown): Promise<void> {
  await apiRequest(path, {
    method: "POST",
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}
