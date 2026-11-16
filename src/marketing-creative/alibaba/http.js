export class AlibabaProviderError extends Error {
  constructor(
    message,
    {
      code = null,
      requestId = null,
      status = null,
      transient = false,
    } = {},
  ) {
    super(message);
    this.name = 'AlibabaProviderError';
    this.code = code;
    this.requestId = requestId;
    this.status = status;
    this.transient = transient;
  }
}

const SAFE_DIAG = /^[A-Za-z0-9_.:-]{1,60}$/;
/** WHY a request ended without an answer, as safe scalars only (error and cause names, codes, errno, syscall, the codes of an AggregateError's members): never a message, a URL, a host or a header. */
export function networkDiagnostics(error) {
  const out = {};
  const put = (key, value) => { if (value !== undefined && value !== null && SAFE_DIAG.test(String(value))) out[key] = String(value); };
  put('error_name', error?.name); put('error_code', error?.code);
  const cause = error?.cause;
  put('cause_name', cause?.name); put('cause_code', cause?.code); put('cause_errno', cause?.errno); put('cause_syscall', cause?.syscall);
  const members = Array.isArray(cause?.errors) ? cause.errors : Array.isArray(error?.errors) ? error.errors : [];
  const codes = members.map((m) => m?.code).filter((c) => typeof c === 'string' && SAFE_DIAG.test(c)).slice(0, 6);
  if (codes.length) out.member_codes = codes.join(',');
  return out;
}

function assertProviderUrl(value) {
  const url = new URL(value);

  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || !url.hostname.endsWith('.eu-central-1.maas.aliyuncs.com')
  ) {
    throw new Error('Refusing non-Frankfurt Alibaba provider URL');
  }

  return url.toString();
}

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

  const safeUrl = assertProviderUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    };
    if (asyncTask) headers['X-DashScope-Async'] = 'enable';

    const response = await fetchImpl(safeUrl, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'error',
    });

    const raw = await response.text();
    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {};
    }

    if (!response.ok) {
      const code = payload?.code || payload?.error?.code || `HTTP_${response.status}`;
      const requestId = payload?.request_id || payload?.requestId || null;
      const transient = response.status === 429 || response.status >= 500;

      throw new AlibabaProviderError(
        `Alibaba Model Studio request failed: ${code}`,
        {
          code,
          requestId,
          status: response.status,
          transient,
        },
      );
    }

    return payload;
  } catch (error) {
    if (error instanceof AlibabaProviderError) throw error;
    // a failure WITHOUT any answer (the connection, not the service): keep WHY, as safe scalars (codes and names, never a message, a URL or a header), for the journal and the report
    if (error?.name !== 'AbortError') { try { error.network = networkDiagnostics(error); } catch { /* diagnostics never change the failure */ } }
    if (error?.name === 'AbortError') {
      throw new AlibabaProviderError(
        'Alibaba Model Studio request timed out',
        { code: 'TIMEOUT', transient: true },
      );
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
