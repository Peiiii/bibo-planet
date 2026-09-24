export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (request.method !== "GET" && request.method !== "POST")
      return Response.json({ error: "不支持此操作" }, { status: 405 });
    if (!env.BIBO_EDGE_SECRET)
      return Response.json({ error: "服务暂时无法连接" }, { status: 503 });
    const target = new URL(
      `/__bibo${url.pathname}${url.search}`,
      env.BIBO_ORIGIN,
    );
    const headers = new Headers(request.headers);
    headers.delete("host");
    headers.delete("x-bibo-edge-secret");
    headers.delete("x-bibo-client-ip");
    headers.set("x-bibo-edge-secret", env.BIBO_EDGE_SECRET);
    headers.set(
      "x-bibo-client-ip",
      request.headers.get("cf-connecting-ip") ?? "unknown",
    );
    try {
      const upstream = await fetch(target, {
        method: request.method,
        headers,
        body: request.method === "GET" ? undefined : request.body,
        redirect: "manual",
      });
      const response = new Response(upstream.body, upstream);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      return response;
    } catch {
      return Response.json(
        { error: "服务暂时无法连接，请稍后重试" },
        { status: 502 },
      );
    }
  },
};
