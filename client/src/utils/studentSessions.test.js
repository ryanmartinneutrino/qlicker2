import { describe, expect, it } from 'vitest';
import { quizWouldBeLiveImmediately } from './studentSessions';

describe('quizWouldBeLiveImmediately', () => {
  const now = new Date('2026-08-28T16:00:00.000Z').getTime();

  it('detects a draft quiz whose scheduled window is currently live', () => {
    expect(quizWouldBeLiveImmediately({
      quiz: true,
      status: 'hidden',
      quizStart: '2026-08-28T15:00:00.000Z',
      quizEnd: '2026-08-28T17:00:00.000Z',
    }, now)).toBe(true);
  });

  it('does not warn for future or already-ended quiz windows', () => {
    expect(quizWouldBeLiveImmediately({
      quiz: true,
      quizStart: '2026-08-28T17:00:00.000Z',
      quizEnd: '2026-08-28T18:00:00.000Z',
    }, now)).toBe(false);
    expect(quizWouldBeLiveImmediately({
      quiz: true,
      quizStart: '2026-08-28T14:00:00.000Z',
      quizEnd: '2026-08-28T15:00:00.000Z',
    }, now)).toBe(false);
  });

  it('does not apply the scheduled quiz warning to interactive sessions', () => {
    expect(quizWouldBeLiveImmediately({
      quiz: false,
      quizStart: '2026-08-28T15:00:00.000Z',
      quizEnd: '2026-08-28T17:00:00.000Z',
    }, now)).toBe(false);
  });
});
