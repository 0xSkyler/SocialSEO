export const ALL_WORKING_PROXY_URL = 'http://169.58.35.69/data/all-working.txt';

const REQUEST_TIMEOUT_MS = 15_000;

export async function fetchAllWorkingProxyText(signal?: AbortSignal): Promise<string> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ALL_WORKING_PROXY_URL, {
      method: 'GET',
      headers: {
        Accept: 'text/plain',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Proxy API returned HTTP ${response.status}.`);
    }

    const text = await response.text();
    if (!text.trim()) throw new Error('Proxy API returned an empty response.');
    return text;
  } catch (err) {
    if (signal?.aborted) throw new Error('Proxy API request cancelled.');
    if (controller.signal.aborted) {
      throw new Error(`Proxy API request timed out after ${REQUEST_TIMEOUT_MS} ms.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
