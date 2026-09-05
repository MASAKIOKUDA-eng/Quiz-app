import { scoreAnswers, ScoredQuestion, toPublicQuestions } from '../lambda/index';

/**
 * Unit tests for the REAL exported scoring helper from the Lambda source.
 * These import the production `scoreAnswers` (not a reimplementation) so
 * they would fail if the scoring logic were broken. `scoreAnswers` is pure
 * (no AWS SDK/DynamoDB), so no mocking is required.
 *
 * Scoring contract: a question with index `n` is correct when
 * `answers[n] === question.answerIndex`.
 */
describe('scoreAnswers', () => {
  const questions: ScoredQuestion[] = [
    { n: 0, answerIndex: 2 },
    { n: 1, answerIndex: 0 },
    { n: 2, answerIndex: 3 },
  ];

  test('all correct answers yield a full score', () => {
    const result = scoreAnswers(questions, [2, 0, 3]);
    expect(result.total).toBe(3);
    expect(result.score).toBe(3);
    expect(result.results).toEqual([
      { n: 0, correct: true, answerIndex: 2 },
      { n: 1, correct: true, answerIndex: 0 },
      { n: 2, correct: true, answerIndex: 3 },
    ]);
  });

  test('partially correct answers yield a partial score', () => {
    // Q0 correct, Q1 wrong, Q2 correct.
    const result = scoreAnswers(questions, [2, 1, 3]);
    expect(result.total).toBe(3);
    expect(result.score).toBe(2);
    expect(result.results.map((r) => r.correct)).toEqual([true, false, true]);
  });

  test('all wrong answers yield a zero score', () => {
    const result = scoreAnswers(questions, [0, 1, 0]);
    expect(result.score).toBe(0);
    expect(result.total).toBe(3);
  });

  test('empty answers array marks everything incorrect', () => {
    const result = scoreAnswers(questions, []);
    expect(result.score).toBe(0);
    expect(result.total).toBe(3);
    expect(result.results.every((r) => r.correct === false)).toBe(true);
  });

  test('mismatched-length answers only score the positions provided', () => {
    // Only the first answer is supplied and it is correct.
    const result = scoreAnswers(questions, [2]);
    expect(result.total).toBe(3);
    expect(result.score).toBe(1);
    expect(result.results[0].correct).toBe(true);
    expect(result.results[1].correct).toBe(false);
    expect(result.results[2].correct).toBe(false);
  });

  test('out-of-range answer indices are treated as incorrect, not thrown', () => {
    const result = scoreAnswers(questions, [99, -1, 42]);
    expect(result.score).toBe(0);
    expect(result.total).toBe(3);
    expect(result.results.every((r) => r.correct === false)).toBe(true);
  });

  test('total reflects the number of questions even with extra answers', () => {
    // Extra answers beyond the question count are ignored.
    const result = scoreAnswers(questions, [2, 0, 3, 1, 1]);
    expect(result.total).toBe(3);
    expect(result.score).toBe(3);
  });

  test('an empty quiz produces a zero-of-zero result', () => {
    const result = scoreAnswers([], []);
    expect(result).toEqual({ score: 0, total: 0, results: [] });
  });
});

/**
 * Tests for the REAL exported `toPublicQuestions` projection used by
 * `GET /quizzes/{quizId}`. This is the security-critical behavior: the
 * correct-answer index must NEVER leak to the client. The handler calls
 * this exact function, so a regression that stopped stripping the answer
 * would fail these tests.
 */
describe('toPublicQuestions (answer stripping)', () => {
  const stored = [
    {
      n: 0,
      text: '日本の首都はどこですか？',
      options: ['大阪', '東京', '京都', '札幌'],
      answerIndex: 1,
    },
    {
      n: 1,
      text: '1 + 1 は？',
      options: ['1', '2', '3'],
      answerIndex: 1,
    },
  ];

  test('never includes answerIndex in the projected payload', () => {
    const publicQuestions = toPublicQuestions(stored);
    for (const q of publicQuestions) {
      expect(Object.prototype.hasOwnProperty.call(q, 'answerIndex')).toBe(false);
    }
    // Also assert against a deep JSON scan, in case a field is nested.
    expect(JSON.stringify(publicQuestions)).not.toContain('answerIndex');
  });

  test('preserves n, text and options exactly', () => {
    const publicQuestions = toPublicQuestions(stored);
    expect(publicQuestions).toEqual([
      { n: 0, text: '日本の首都はどこですか？', options: ['大阪', '東京', '京都', '札幌'] },
      { n: 1, text: '1 + 1 は？', options: ['1', '2', '3'] },
    ]);
  });

  test('returns an empty array for an empty quiz', () => {
    expect(toPublicQuestions([])).toEqual([]);
  });
});
