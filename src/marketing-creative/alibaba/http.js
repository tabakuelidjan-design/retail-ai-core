export async function alibabaJsonRequest({
  url,
  apiKey,
  method = 'POST',
  body,
  asyncTask = false,
  timeoutMs = 120000,
  fetchImpl = globalThis.fetch,
}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (asyncTask) headers['X-DashScope-Async'] = 'enable';

    const response = await fetchImpl(url, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const raw = await response.text();
    let payload = null;
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = { message: 'Non-JSON provider response' };
    }

    if (!response.ok) {
      const code = payload?.code || payload?.error?.code || `HTTP_${response.status}`;
      throw new Error(`Alibaba Model Studio request failed: ${code}`);
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}
