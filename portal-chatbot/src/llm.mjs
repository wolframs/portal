// One chat completion against an OpenAI-compatible endpoint (Surplus or
// OpenRouter): text in, text out, no tools, no streaming.

/** The request body for a route. Only allowlisted generation parameters are
 *  sent; the route's extra fields (provider, si_route, …) go in at top level. */
export function buildBody(route, messages) {
  const params = {};
  for (const [k, v] of Object.entries(route.params ?? {})) {
    if (route.allowedParams.includes(k)) params[k] = v;
  }
  if (route.allowedParams.includes('max_tokens')) params.max_tokens = route.maxTokens;
  return { ...route.extra, ...params, model: route.model, messages };
}

const requestIdOf = (res, body) =>
  res.headers?.get?.('x-request-id') ?? body?.request_id ?? body?.error?.request_id ?? null;

/** POST the completion. Resolves (never rejects on an HTTP status, readable
 *  body or not) with what the meter needs; rejects only when no response
 *  arrived at all. */
export async function complete(route, key, messages, fetchImpl = fetch) {
  const res = await fetchImpl(`${route.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(buildBody(route, messages)),
  });
  // A body that cannot be read must not lose the status: a 402 still holds.
  let text;
  try {
    text = await res.text();
  } catch (e) {
    text = `(body unreadable: ${e?.message || e})`;
  }
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON error page; keep the text for the log
  }
  return {
    ok: res.ok,
    status: res.status,
    reply: res.ok ? body?.choices?.[0]?.message?.content?.trim() || null : null,
    usage: body?.usage ?? null,
    requestId: requestIdOf(res, body),
    responseId: body?.id ?? null,
    errorText: res.ok ? null : (body ? JSON.stringify(body) : text).slice(0, 300),
  };
}
