import { describe, expect, it } from 'vitest';
import { distributeSavedUrls, parseSavedUrlPool } from '../src/shared/urlPool';

describe('saved URL pool', () => {
  it('normalizes and deduplicates one URL per line', () => {
    expect(parseSavedUrlPool('example.com/a\nhttps://example.org/b\nexample.com/a')).toEqual([
      'https://example.com/a',
      'https://example.org/b'
    ]);
  });

  it('reuses links only as needed when browsers outnumber links', () => {
    const assignments = distributeSavedUrls([1, 2, 3, 4, 5], ['https://a.test/', 'https://b.test/'], () => 0);
    expect(assignments).toHaveLength(5);
    expect(new Set(assignments.map((item) => item.id)).size).toBe(5);
    const counts = assignments.reduce<Record<string, number>>((acc, item) => {
      acc[item.url] = (acc[item.url] ?? 0) + 1;
      return acc;
    }, {});
    expect(Object.values(counts).sort()).toEqual([2, 3]);
  });

  it('uses a random subset when there are more links than browsers', () => {
    const assignments = distributeSavedUrls([1, 2], ['https://a.test/', 'https://b.test/', 'https://c.test/'], () => 0.5);
    expect(assignments).toHaveLength(2);
    expect(new Set(assignments.map((item) => item.url)).size).toBe(2);
  });
});
