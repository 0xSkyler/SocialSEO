export interface UrlPoolAssignment {
  id: number;
  url: string;
}

function normalizeOneUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('URL cannot be empty.');
  const candidate = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`Unsupported URL protocol: ${parsed.protocol}`);
  return parsed.toString();
}

export function parseSavedUrlPool(text: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim() ?? '';
    if (!raw) continue;
    let normalized: string;
    try {
      normalized = normalizeOneUrl(raw);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Link ${index + 1} is invalid: ${reason}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const next = Math.floor(Math.min(0.999999999, Math.max(0, random())) * (index + 1));
    [copy[index], copy[next]] = [copy[next] as T, copy[index] as T];
  }
  return copy;
}

export function distributeSavedUrls(workspaceIds: readonly number[], urls: readonly string[], random: () => number = Math.random): UrlPoolAssignment[] {
  const ids = [...new Set(workspaceIds)].sort((a, b) => a - b);
  if (!ids.length) return [];
  if (!urls.length) throw new Error('Save at least one website link before random distribution.');

  const randomizedIds = shuffled(ids, random);
  const queue: string[] = [];
  while (queue.length < randomizedIds.length) queue.push(...shuffled(urls, random));

  return randomizedIds.map((id, index) => ({ id, url: queue[index] as string }));
}
