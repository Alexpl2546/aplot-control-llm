import { expect, it } from 'vitest';
import { isRussianReasoning, reasoningChunks } from '../src/features/chat/reasoningLanguage';

it('recognizes Russian prose while retaining code, URLs and multilingual source', () => {
  expect(isRussianReasoning('Нужно подготовить приложение. Код: `const result = calculate(value)` и https://example.com/path')).toBe(true);
  expect(isRussianReasoning('The user wants a calculator. Let me think about design.')).toBe(false);
  expect(isRussianReasoning('需要先分析用户的问题，然后生成答案。')).toBe(false);
  expect(isRussianReasoning('```js\nconst result = calculate(value);\n```')).toBe(true);
});
it('splits long translations into bounded complete source chunks without losing whitespace', () => {
  const source = 'The user wants an app.\n'.repeat(300);
  const chunks = reasoningChunks(source, 700);
  expect(chunks.join('')).toBe(source);
  expect(chunks.every(c => c.length <= 701)).toBe(true);
  expect(chunks.length).toBeGreaterThan(1);
});
