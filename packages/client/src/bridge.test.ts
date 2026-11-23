import { expect, test } from 'vitest';
import { nodeFor } from './repo';

test('backends, net and llm go to the connector, else the bridge', () => {
  expect(nodeFor({ url: null }, null)).toBeNull();
  expect(nodeFor({ url: null }, 'http://127.0.0.1:7717')).toBe('http://127.0.0.1:7717/');
  expect(nodeFor({ url: 'http://127.0.0.1:7737/' }, 'http://127.0.0.1:7717')).toBe('http://127.0.0.1:7737/');
  expect(nodeFor({ url: 'http://127.0.0.1:7737' }, null)).toBe('http://127.0.0.1:7737/');
});
