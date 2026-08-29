import { describe, it, expect } from 'vitest';
import { APP_NAME, APP_VERSION, main } from './index.js';

describe('app scaffold', () => {
  it('exposes app metadata', () => {
    expect(APP_NAME).toBe('hermes-fleet-ctrl');
    expect(typeof APP_VERSION).toBe('string');
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('main() runs without throwing', () => {
    expect(() => main()).not.toThrow();
  });
});
