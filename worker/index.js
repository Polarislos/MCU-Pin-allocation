/**
 * Static SPA entry point for the ChatGPT Sites worker runtime.
 * Vite emits the browser assets into dist/; Sites exposes them through ASSETS.
 */
export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404) return response;

    const method = request.method.toUpperCase();
    if (method !== "GET" && method !== "HEAD") return response;

    const fallbackUrl = new URL("/index.html", request.url);
    return env.ASSETS.fetch(new Request(fallbackUrl, request));
  },
};
