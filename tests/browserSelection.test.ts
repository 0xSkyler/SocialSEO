import { describe, expect, it } from 'vitest';
import { formatBrowserSelection, parseBrowserSelection } from '../src/shared/browserSelection';

describe('browser selection parser', () => {
  const ids = Array.from({ length: 20 }, (_, index) => index + 1);

  it('parses single ids and ranges', () => {
    expect(parseBrowserSelection('1-5,8,10', ids)).toEqual([1, 2, 3, 4, 5, 8, 10]);
  });

  it('accepts reversed ranges and removes duplicates', () => {
    expect(parseBrowserSelection('5-3,4,3', ids)).toEqual([3, 4, 5]);
  });

  it('ignores ids outside the active fleet', () => {
    expect(parseBrowserSelection('1,20,21,99', ids)).toEqual([1, 20]);
  });

  it('formats contiguous selections compactly', () => {
    expect(formatBrowserSelection([1, 2, 3, 6, 8, 9, 10])).toBe('1-3,6,8-10');
  });
});
