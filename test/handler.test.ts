import {
  scoreAnswers,
  ScoredQuestion,
  toPublicQuestions,
  validateAndNormalizeQuizInput,
  validateAndNormalizeQuizUpdate,
} from '../lambda/index';
import {
  generateRoomId,
  aggregateScoreboard,
  nextGamePhase,
  toParticipantQuestion,
  scoreSingleAnswer,
  validateJoinInput,
  validateTokenClaims,
  ROOM_ID_ALPHABET,
  ROOM_ID_LENGTH,
} from '../lambda/ws';
import { SAMPLE_QUIZZES } from '../lambda/seed-data';

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

/**
 * Tests for the REAL exported `validateAndNormalizeQuizInput` helper used by
 * the authenticated admin write route (POST /api/admin/quizzes). It is a
 * pure function (no AWS calls) that validates and normalizes an untrusted
 * quiz-creation payload.
 */
describe('validateAndNormalizeQuizInput', () => {
  const validInput = {
    quizId: 'my-quiz',
    title: '  My Quiz  ',
    questions: [
      { text: 'Q1', options: ['a', 'b', 'c'], answerIndex: 2 },
      { text: 'Q2', options: ['x', 'y'], answerIndex: 0 },
    ],
  };

  test('normalizes valid input (trims title/options, keeps quizId)', () => {
    const result = validateAndNormalizeQuizInput(validInput);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.quizId).toBe('my-quiz');
      expect(result.quiz.title).toBe('My Quiz');
      expect(result.quiz.questions).toHaveLength(2);
      expect(result.quiz.questions[0]).toEqual({
        text: 'Q1',
        options: ['a', 'b', 'c'],
        answerIndex: 2,
      });
    }
  });

  test('rejects a non-object body', () => {
    expect(validateAndNormalizeQuizInput(null).ok).toBe(false);
    expect(validateAndNormalizeQuizInput('nope').ok).toBe(false);
    expect(validateAndNormalizeQuizInput(42).ok).toBe(false);
  });

  test('rejects missing or empty title', () => {
    expect(
      validateAndNormalizeQuizInput({ questions: validInput.questions }).ok,
    ).toBe(false);
    expect(
      validateAndNormalizeQuizInput({ title: '   ', questions: validInput.questions }).ok,
    ).toBe(false);
  });

  test('rejects an empty or missing questions array', () => {
    expect(validateAndNormalizeQuizInput({ title: 'T', questions: [] }).ok).toBe(
      false,
    );
    expect(validateAndNormalizeQuizInput({ title: 'T' }).ok).toBe(false);
  });

  test('rejects a question with fewer than 2 options', () => {
    const result = validateAndNormalizeQuizInput({
      title: 'T',
      questions: [{ text: 'Q', options: ['only'], answerIndex: 0 }],
    });
    expect(result.ok).toBe(false);
  });

  test('rejects a question with empty option strings', () => {
    const result = validateAndNormalizeQuizInput({
      title: 'T',
      questions: [{ text: 'Q', options: ['a', '  '], answerIndex: 0 }],
    });
    expect(result.ok).toBe(false);
  });

  test('rejects an answerIndex out of range', () => {
    expect(
      validateAndNormalizeQuizInput({
        title: 'T',
        questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: 2 }],
      }).ok,
    ).toBe(false);
    expect(
      validateAndNormalizeQuizInput({
        title: 'T',
        questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: -1 }],
      }).ok,
    ).toBe(false);
    expect(
      validateAndNormalizeQuizInput({
        title: 'T',
        questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: 1.5 }],
      }).ok,
    ).toBe(false);
  });

  test('rejects an invalid quizId format', () => {
    const result = validateAndNormalizeQuizInput({
      quizId: 'Bad_ID!',
      title: 'T',
      questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: 0 }],
    });
    expect(result.ok).toBe(false);
  });

  test('auto-generates a URL-safe quizId when omitted', () => {
    const result = validateAndNormalizeQuizInput({
      title: 'Hello World Quiz',
      questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: 0 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.quizId).toMatch(/^[a-z0-9-]+$/);
      expect(result.quiz.quizId.length).toBeGreaterThan(0);
      expect(result.quiz.quizId).toContain('hello-world-quiz');
    }
  });

  test('auto-generates a non-empty URL-safe quizId for a non-ASCII title', () => {
    const result = validateAndNormalizeQuizInput({
      title: 'アーキテクチャ クイズ',
      questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: 0 }],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.quizId).toMatch(/^[a-z0-9-]+$/);
      expect(result.quiz.quizId.length).toBeGreaterThan(0);
    }
  });
});

/**
 * Tests for the REAL exported `validateAndNormalizeQuizUpdate` helper used by
 * the authenticated admin EDIT route (PUT /api/admin/quizzes/{quizId}). Like
 * the create validator it is pure (no AWS calls), but the quizId comes from
 * the request PATH: it is set from the argument, never read from the body and
 * never auto-generated.
 */
describe('validateAndNormalizeQuizUpdate', () => {
  const validBody = {
    title: '  Edited Quiz  ',
    questions: [
      { text: 'Q1', options: ['a', 'b', 'c'], answerIndex: 2 },
      { text: 'Q2', options: ['x', 'y'], answerIndex: 0 },
    ],
  };

  test('normalizes valid input and sets quizId from the path argument', () => {
    const result = validateAndNormalizeQuizUpdate(validBody, 'path-id');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.quizId).toBe('path-id');
      expect(result.quiz.title).toBe('Edited Quiz');
      expect(result.quiz.questions).toHaveLength(2);
      expect(result.quiz.questions[0]).toEqual({
        text: 'Q1',
        options: ['a', 'b', 'c'],
        answerIndex: 2,
      });
    }
  });

  test('a body-supplied quizId does NOT override the path quizId', () => {
    const result = validateAndNormalizeQuizUpdate(
      { ...validBody, quizId: 'body-id' },
      'path-id',
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.quiz.quizId).toBe('path-id');
    }
  });

  test('rejects a non-object body', () => {
    expect(validateAndNormalizeQuizUpdate(null, 'p').ok).toBe(false);
    expect(validateAndNormalizeQuizUpdate('nope', 'p').ok).toBe(false);
    expect(validateAndNormalizeQuizUpdate(42, 'p').ok).toBe(false);
  });

  test('rejects missing or empty title', () => {
    expect(
      validateAndNormalizeQuizUpdate({ questions: validBody.questions }, 'p').ok,
    ).toBe(false);
    expect(
      validateAndNormalizeQuizUpdate(
        { title: '   ', questions: validBody.questions },
        'p',
      ).ok,
    ).toBe(false);
  });

  test('rejects an empty or missing questions array', () => {
    expect(
      validateAndNormalizeQuizUpdate({ title: 'T', questions: [] }, 'p').ok,
    ).toBe(false);
    expect(validateAndNormalizeQuizUpdate({ title: 'T' }, 'p').ok).toBe(false);
  });

  test('rejects a question with fewer than 2 options', () => {
    const result = validateAndNormalizeQuizUpdate(
      { title: 'T', questions: [{ text: 'Q', options: ['only'], answerIndex: 0 }] },
      'p',
    );
    expect(result.ok).toBe(false);
  });

  test('rejects a question with empty option strings', () => {
    const result = validateAndNormalizeQuizUpdate(
      { title: 'T', questions: [{ text: 'Q', options: ['a', '  '], answerIndex: 0 }] },
      'p',
    );
    expect(result.ok).toBe(false);
  });

  test('rejects an out-of-range or non-integer answerIndex', () => {
    expect(
      validateAndNormalizeQuizUpdate(
        { title: 'T', questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: 2 }] },
        'p',
      ).ok,
    ).toBe(false);
    expect(
      validateAndNormalizeQuizUpdate(
        { title: 'T', questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: -1 }] },
        'p',
      ).ok,
    ).toBe(false);
    expect(
      validateAndNormalizeQuizUpdate(
        { title: 'T', questions: [{ text: 'Q', options: ['a', 'b'], answerIndex: 1.5 }] },
        'p',
      ).ok,
    ).toBe(false);
  });
});

/**
 * Validates the shipped seed data (SAMPLE_QUIZZES) so that a malformed quiz,
 * an out-of-range answerIndex, a non-URL-safe quizId, or a shrunk primary
 * quiz would fail the build. These tests run without AWS.
 */
describe('SAMPLE_QUIZZES seed data validity', () => {
  test('at least one quiz has 10 or more questions', () => {
    const maxQuestions = Math.max(...SAMPLE_QUIZZES.map((q) => q.questions.length));
    expect(maxQuestions).toBeGreaterThanOrEqual(10);
  });

  test('every question has valid text/options/answerIndex', () => {
    for (const quiz of SAMPLE_QUIZZES) {
      for (const question of quiz.questions) {
        expect(typeof question.text).toBe('string');
        expect(question.text.length).toBeGreaterThan(0);
        expect(Array.isArray(question.options)).toBe(true);
        expect(question.options.length).toBeGreaterThanOrEqual(2);
        for (const option of question.options) {
          expect(typeof option).toBe('string');
          expect(option.length).toBeGreaterThan(0);
        }
        expect(Number.isInteger(question.answerIndex)).toBe(true);
        expect(question.answerIndex).toBeGreaterThanOrEqual(0);
        expect(question.answerIndex).toBeLessThan(question.options.length);
        // Each question carries exactly the SeedQuestion fields.
        expect(Object.keys(question).sort()).toEqual(['answerIndex', 'options', 'text']);
      }
    }
  });

  test('all quizIds are unique and URL-safe', () => {
    const quizIds = SAMPLE_QUIZZES.map((q) => q.quizId);
    expect(new Set(quizIds).size).toBe(quizIds.length);
    for (const quizId of quizIds) {
      expect(quizId).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

/**
 * Realtime battle (FEAT-002) PURE helpers imported from the REAL WebSocket
 * handler source (lambda/ws.ts). These are pure (no AWS SDK), so no mocking
 * is required. The security-critical test proves toParticipantQuestion never
 * leaks answerIndex, mirroring the toPublicQuestions test above.
 */
describe('generateRoomId', () => {
  const idPattern = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`);

  test('matches the documented alphabet and length', () => {
    for (let i = 0; i < 200; i++) {
      const id = generateRoomId();
      expect(id).toHaveLength(ROOM_ID_LENGTH);
      expect(id).toMatch(idPattern);
    }
  });

  test('excludes ambiguous glyphs (0, O, 1, I, L)', () => {
    for (const ch of ['0', 'O', '1', 'I', 'L']) {
      expect(ROOM_ID_ALPHABET).not.toContain(ch);
    }
  });

  test('is reasonably unique across many calls', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      ids.add(generateRoomId());
    }
    // Collisions in 1000 draws from 31^6 (~887M) should be vanishingly rare.
    expect(ids.size).toBeGreaterThan(995);
  });
});

describe('aggregateScoreboard', () => {
  test('sorts by score descending', () => {
    const board = aggregateScoreboard([
      { name: 'alice', score: 1 },
      { name: 'bob', score: 3 },
      { name: 'carol', score: 2 },
    ]);
    expect(board).toEqual([
      { name: 'bob', score: 3 },
      { name: 'carol', score: 2 },
      { name: 'alice', score: 1 },
    ]);
  });

  test('breaks ties by name ascending', () => {
    const board = aggregateScoreboard([
      { name: 'charlie', score: 2 },
      { name: 'alice', score: 2 },
      { name: 'bob', score: 2 },
    ]);
    expect(board.map((e) => e.name)).toEqual(['alice', 'bob', 'charlie']);
  });

  test('returns only name and score (no extra fields)', () => {
    const board = aggregateScoreboard([{ name: 'a', score: 5 }]);
    expect(Object.keys(board[0]).sort()).toEqual(['name', 'score']);
  });

  test('handles an empty roster', () => {
    expect(aggregateScoreboard([])).toEqual([]);
  });
});

describe('nextGamePhase (state machine)', () => {
  test('lobby -> in_question when there are questions', () => {
    expect(nextGamePhase('lobby', 3, -1)).toBe('in_question');
  });

  test('lobby -> finished when there are no questions', () => {
    expect(nextGamePhase('lobby', 0, -1)).toBe('finished');
  });

  test('in_question -> between', () => {
    expect(nextGamePhase('in_question', 3, 0)).toBe('between');
  });

  test('between -> in_question when more questions remain', () => {
    expect(nextGamePhase('between', 3, 0)).toBe('in_question');
    expect(nextGamePhase('between', 3, 1)).toBe('in_question');
  });

  test('between -> finished after the final question', () => {
    expect(nextGamePhase('between', 3, 2)).toBe('finished');
  });

  test('finished is terminal', () => {
    expect(nextGamePhase('finished', 3, 2)).toBe('finished');
  });

  test('walks the full lifecycle of a 2-question game', () => {
    // lobby -> in_question(0) -> between -> in_question(1) -> between ->
    // finished
    let phase = nextGamePhase('lobby', 2, -1);
    expect(phase).toBe('in_question');
    phase = nextGamePhase(phase, 2, 0);
    expect(phase).toBe('between');
    phase = nextGamePhase(phase, 2, 0);
    expect(phase).toBe('in_question');
    phase = nextGamePhase(phase, 2, 1);
    expect(phase).toBe('between');
    phase = nextGamePhase(phase, 2, 1);
    expect(phase).toBe('finished');
  });
});

describe('toParticipantQuestion (answer stripping)', () => {
  const stored = {
    n: 0,
    text: '日本の首都はどこですか？',
    options: ['大阪', '東京', '京都', '札幌'],
    answerIndex: 1,
  };

  test('never includes answerIndex in the projected payload', () => {
    const projected = toParticipantQuestion(stored);
    expect(Object.prototype.hasOwnProperty.call(projected, 'answerIndex')).toBe(
      false,
    );
    // Deep JSON scan in case a field is nested.
    expect(JSON.stringify(projected)).not.toContain('answerIndex');
  });

  test('preserves n, text and options exactly', () => {
    expect(toParticipantQuestion(stored)).toEqual({
      n: 0,
      text: '日本の首都はどこですか？',
      options: ['大阪', '東京', '京都', '札幌'],
    });
  });
});

describe('scoreSingleAnswer', () => {
  test('true only when the submitted index equals the stored answer', () => {
    expect(scoreSingleAnswer(2, 2)).toBe(true);
    expect(scoreSingleAnswer(2, 1)).toBe(false);
    expect(scoreSingleAnswer(0, 0)).toBe(true);
  });

  test('non-integer submissions are incorrect', () => {
    expect(scoreSingleAnswer(1, 1.5)).toBe(false);
    expect(scoreSingleAnswer(1, NaN)).toBe(false);
  });
});

describe('validateJoinInput', () => {
  test('accepts a valid name + roomId (normalizing them)', () => {
    const validRoomId = ROOM_ID_ALPHABET.slice(0, ROOM_ID_LENGTH); // e.g. ABCDEF
    const result = validateJoinInput({ name: '  たろう  ', roomId: validRoomId.toLowerCase() });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe('たろう');
      // roomId is upper-cased/trimmed to the canonical shape.
      expect(result.roomId).toBe(validRoomId);
    }
  });

  test('rejects a non-object body', () => {
    expect(validateJoinInput(null).ok).toBe(false);
    expect(validateJoinInput('nope').ok).toBe(false);
    expect(validateJoinInput(42).ok).toBe(false);
  });

  test('rejects an empty or missing name', () => {
    const roomId = ROOM_ID_ALPHABET.slice(0, ROOM_ID_LENGTH);
    expect(validateJoinInput({ roomId }).ok).toBe(false);
    expect(validateJoinInput({ name: '   ', roomId }).ok).toBe(false);
  });

  test('rejects an over-long name', () => {
    const roomId = ROOM_ID_ALPHABET.slice(0, ROOM_ID_LENGTH);
    expect(validateJoinInput({ name: 'x'.repeat(41), roomId }).ok).toBe(false);
  });

  test('rejects an invalid roomId shape', () => {
    expect(validateJoinInput({ name: 'a', roomId: 'short' }).ok).toBe(false);
    expect(validateJoinInput({ name: 'a', roomId: '' }).ok).toBe(false);
    // Contains an ambiguous glyph excluded from the alphabet (0/O/1/I/L).
    expect(validateJoinInput({ name: 'a', roomId: 'ABC01I' }).ok).toBe(false);
    expect(validateJoinInput({ name: 'a', roomId: 123456 }).ok).toBe(false);
  });
});

/**
 * Tests for the REAL exported `validateTokenClaims` helper — the PURE,
 * signature-free part of host Cognito id-token verification (alg/kid/exp/iss/
 * aud/token_use/sub). Extracting it lets us unit-test the security-critical
 * REJECT paths without AWS/JWKS/network (the RS256 signature check stays in the
 * AWS-touching `verifyHostToken`). `now` is injected for deterministic exp.
 */
describe('validateTokenClaims (host token reject paths)', () => {
  const issuer = 'https://cognito-idp.ap-northeast-1.amazonaws.com/pool';
  const clientId = 'abc123clientid';
  const expected = { issuer, clientId };
  const NOW = 1_700_000_000;

  const goodHeader = { alg: 'RS256', kid: 'key-1' };
  const goodPayload = {
    exp: NOW + 3600,
    iss: issuer,
    aud: clientId,
    token_use: 'id',
    sub: 'user-sub-123',
  };

  test('accepts a fully valid header + payload and returns sub + kid', () => {
    const result = validateTokenClaims(goodHeader, goodPayload, expected, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.sub).toBe('user-sub-123');
      expect(result.kid).toBe('key-1');
    }
  });

  test('rejects a non-RS256 alg (e.g. none/HS256)', () => {
    expect(
      validateTokenClaims({ alg: 'none', kid: 'key-1' }, goodPayload, expected, NOW).ok,
    ).toBe(false);
    expect(
      validateTokenClaims({ alg: 'HS256', kid: 'key-1' }, goodPayload, expected, NOW).ok,
    ).toBe(false);
  });

  test('rejects a missing or empty kid', () => {
    expect(validateTokenClaims({ alg: 'RS256' }, goodPayload, expected, NOW).ok).toBe(
      false,
    );
    expect(
      validateTokenClaims({ alg: 'RS256', kid: '' }, goodPayload, expected, NOW).ok,
    ).toBe(false);
  });

  test('rejects an expired token (exp in the past)', () => {
    const result = validateTokenClaims(
      goodHeader,
      { ...goodPayload, exp: NOW - 1 },
      expected,
      NOW,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('token expired');
    }
  });

  test('rejects a missing or non-numeric exp', () => {
    const { exp: _drop, ...noExp } = goodPayload;
    expect(validateTokenClaims(goodHeader, noExp, expected, NOW).ok).toBe(false);
    expect(
      validateTokenClaims(goodHeader, { ...goodPayload, exp: 'soon' }, expected, NOW).ok,
    ).toBe(false);
  });

  test('rejects an issuer mismatch', () => {
    const result = validateTokenClaims(
      goodHeader,
      { ...goodPayload, iss: 'https://evil.example/pool' },
      expected,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  test('rejects an audience mismatch (e.g. an access token / wrong client)', () => {
    const result = validateTokenClaims(
      goodHeader,
      { ...goodPayload, aud: 'some-other-client' },
      expected,
      NOW,
    );
    expect(result.ok).toBe(false);
  });

  test('rejects a missing token_use (tightened: must be exactly "id")', () => {
    const { token_use: _drop, ...noUse } = goodPayload;
    const result = validateTokenClaims(goodHeader, noUse, expected, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('token_use must be id');
    }
  });

  test('rejects a non-"id" token_use (e.g. an access token)', () => {
    expect(
      validateTokenClaims(
        goodHeader,
        { ...goodPayload, token_use: 'access' },
        expected,
        NOW,
      ).ok,
    ).toBe(false);
  });

  test('rejects a missing or empty sub', () => {
    const { sub: _drop, ...noSub } = goodPayload;
    expect(validateTokenClaims(goodHeader, noSub, expected, NOW).ok).toBe(false);
    expect(
      validateTokenClaims(goodHeader, { ...goodPayload, sub: '' }, expected, NOW).ok,
    ).toBe(false);
  });
});
