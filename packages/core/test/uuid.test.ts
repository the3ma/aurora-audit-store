import { describe, expect, it } from 'vitest';
import { isUuid, uuidV5 } from '../src/index.js';

const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

describe('uuidV5', () => {
  it('matches the reference implementation (RFC 9562 namespace DNS)', () => {
    // Python: uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')
    expect(uuidV5('python.org', NAMESPACE_DNS)).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('is deterministic and sets version 5 / RFC variant bits', () => {
    const a = uuidV5('TENANT#t-042|DATE#2024', NAMESPACE_DNS);
    expect(uuidV5('TENANT#t-042|DATE#2024', NAMESPACE_DNS)).toBe(a);
    expect(a[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(a[19]);
    expect(isUuid(a)).toBe(true);
  });

  it('rejects a non-UUID namespace', () => {
    expect(() => uuidV5('x', 'not-a-uuid')).toThrow(TypeError);
  });
});
