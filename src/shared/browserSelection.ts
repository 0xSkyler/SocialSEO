export function parseBrowserSelection(input: string, validIds: number[]): number[] {
  const allowed = new Set(validIds);
  const selected = new Set<number>();
  const text = input.trim();
  if (!text) return [];

  for (const rawPart of text.split(',')) {
    const part = rawPart.trim();
    if (!part) continue;

    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (let id = low; id <= high; id += 1) {
        if (allowed.has(id)) selected.add(id);
      }
      continue;
    }

    const single = Number(part);
    if (Number.isInteger(single) && allowed.has(single)) selected.add(single);
  }

  return [...selected].sort((a, b) => a - b);
}

export function formatBrowserSelection(ids: number[]): string {
  const sorted = [...new Set(ids)].sort((a, b) => a - b);
  if (!sorted.length) return '';
  const parts: string[] = [];
  let start = sorted[0]!;
  let previous = start;

  const flush = () => {
    parts.push(start === previous ? String(start) : `${start}-${previous}`);
  };

  for (const id of sorted.slice(1)) {
    if (id === previous + 1) {
      previous = id;
      continue;
    }
    flush();
    start = id;
    previous = id;
  }
  flush();
  return parts.join(',');
}
