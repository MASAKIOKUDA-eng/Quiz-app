import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { SAMPLE_QUIZZES } from './seed-data';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not set');
  }
  return name;
}

export interface ScoredQuestion {
  n: number;
  answerIndex: number;
}

export interface ScoreResult {
  score: number;
  total: number;
  results: { n: number; correct: boolean; answerIndex: number }[];
}

export interface PublicQuestion {
  n: number;
  text: string;
  options: string[];
}

/**
 * Pure projection that strips the security-critical `answerIndex` (and any
 * other server-only fields) from stored questions before they are returned
 * to the client. Exported so it can be unit-tested without AWS.
 */
export function toPublicQuestions(
  questions: { n: number; text: string; options: string[] }[],
): PublicQuestion[] {
  return questions.map((q) => ({ n: q.n, text: q.text, options: q.options }));
}

/**
 * Pure scoring helper (no AWS dependencies) so it can be unit-tested.
 * A question is correct when the submitted answer at the same position
 * (by `n`) equals its `answerIndex`.
 */
export function scoreAnswers(
  questions: ScoredQuestion[],
  answers: number[],
): ScoreResult {
  const results = questions.map((q) => ({
    n: q.n,
    correct: answers[q.n] === q.answerIndex,
    answerIndex: q.answerIndex,
  }));
  return {
    score: results.filter((r) => r.correct).length,
    total: questions.length,
    results,
  };
}

export interface NormalizedQuizQuestion {
  text: string;
  options: string[];
  answerIndex: number;
}

export interface NormalizedQuiz {
  quizId: string;
  title: string;
  questions: NormalizedQuizQuestion[];
}

export type ValidateQuizResult =
  | { ok: true; quiz: NormalizedQuiz }
  | { ok: false; error: string };

const QUIZ_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Turn an arbitrary title into a URL-safe slug of the shape `[a-z0-9-]+`.
 * Non-ASCII (e.g. Japanese) characters are dropped, so a title with no
 * ASCII alphanumerics yields an empty string; callers combine this with a
 * short suffix and a fallback so the final id is always non-empty.
 */
function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Shared, pure validation + normalization for the `{title, questions[]}`
 * portion of an admin quiz payload. Used by BOTH the create route
 * (validateAndNormalizeQuizInput) and the edit route
 * (validateAndNormalizeQuizUpdate) so their per-question rules stay in
 * sync. Contains NO AWS SDK calls and does NOT touch quizId (each entry
 * point owns its own quizId policy). Returns the normalized title +
 * questions on success, or a human-readable error on failure.
 */
function validateTitleAndQuestions(
  input: unknown,
):
  | { ok: true; title: string; questions: NormalizedQuizQuestion[] }
  | { ok: false; error: string } {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.title !== 'string' || obj.title.trim().length === 0) {
    return { ok: false, error: 'title must be a non-empty string' };
  }
  const title = obj.title.trim();

  if (!Array.isArray(obj.questions) || obj.questions.length === 0) {
    return { ok: false, error: 'questions must be a non-empty array' };
  }

  const questions: NormalizedQuizQuestion[] = [];
  for (let i = 0; i < obj.questions.length; i++) {
    const raw = obj.questions[i];
    if (typeof raw !== 'object' || raw === null) {
      return { ok: false, error: `question ${i} must be an object` };
    }
    const q = raw as Record<string, unknown>;

    if (typeof q.text !== 'string' || q.text.trim().length === 0) {
      return { ok: false, error: `question ${i} text must be a non-empty string` };
    }

    if (!Array.isArray(q.options) || q.options.length < 2) {
      return {
        ok: false,
        error: `question ${i} must have at least 2 options`,
      };
    }
    const options: string[] = [];
    for (const opt of q.options) {
      if (typeof opt !== 'string' || opt.trim().length === 0) {
        return {
          ok: false,
          error: `question ${i} options must all be non-empty strings`,
        };
      }
      options.push(opt.trim());
    }

    if (
      typeof q.answerIndex !== 'number' ||
      !Number.isInteger(q.answerIndex) ||
      q.answerIndex < 0 ||
      q.answerIndex >= options.length
    ) {
      return {
        ok: false,
        error: `question ${i} answerIndex must be an integer within the options range`,
      };
    }

    questions.push({ text: q.text.trim(), options, answerIndex: q.answerIndex });
  }

  return { ok: true, title, questions };
}

/**
 * Pure validation + normalization for the admin quiz-creation payload.
 * Contains NO AWS SDK calls so it can be unit-tested in isolation.
 *
 * On success returns the normalized quiz with a guaranteed URL-safe
 * `quizId` (auto-generated from the title plus a short suffix when the
 * caller does not supply one). On failure returns a human-readable error.
 */
export function validateAndNormalizeQuizInput(
  input: unknown,
): ValidateQuizResult {
  const base = validateTitleAndQuestions(input);
  if (!base.ok) {
    return base;
  }
  const { title, questions } = base;
  const obj = input as Record<string, unknown>;

  // quizId: use the caller's value if valid, otherwise auto-generate a
  // URL-safe slug from the title plus a short suffix for uniqueness.
  let quizId: string;
  if (obj.quizId !== undefined && obj.quizId !== null && obj.quizId !== '') {
    if (typeof obj.quizId !== 'string' || !QUIZ_ID_PATTERN.test(obj.quizId)) {
      return {
        ok: false,
        error: 'quizId must match /^[a-z0-9-]+$/',
      };
    }
    quizId = obj.quizId;
  } else {
    const slug = slugify(title);
    const suffix = Date.now().toString(36).slice(-6);
    quizId = slug ? `${slug}-${suffix}` : `quiz-${suffix}`;
  }

  return { ok: true, quiz: { quizId, title, questions } };
}

/**
 * Pure validation + normalization for the admin quiz-EDIT payload
 * (PUT /api/admin/quizzes/{quizId}). The edit is full-replace and the
 * quizId comes from the request PATH, so the body's `{title, questions[]}`
 * is validated with the SAME per-question rules as the create route while
 * the `quizId` is set from the given `quizId` argument. Any `quizId` in the
 * body is ignored (never overrides the path, never auto-generated).
 * Contains NO AWS SDK calls so it can be unit-tested in isolation.
 */
export function validateAndNormalizeQuizUpdate(
  input: unknown,
  quizId: string,
): ValidateQuizResult {
  const base = validateTitleAndQuestions(input);
  if (!base.ok) {
    return base;
  }
  return {
    ok: true,
    quiz: { quizId, title: base.title, questions: base.questions },
  };
}

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN ?? '*';

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': ALLOWED_ORIGIN,
};

function json(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  };
}

interface QuizMetaItem {
  pk: string;
  sk: string;
  type: 'META';
  quizId: string;
  title: string;
  questionCount: number;
}

interface QuestionItem {
  pk: string;
  sk: string;
  type: 'QUESTION';
  quizId: string;
  n: number;
  text: string;
  options: string[];
  answerIndex: number;
}

/**
 * Build the DynamoDB items (META + one QUESTION per question) for a single
 * quiz using the canonical single-table item shapes. Shared by the seeder
 * and the admin write route so both stay in sync.
 */
function buildQuizItems(quiz: {
  quizId: string;
  title: string;
  questions: { text: string; options: string[]; answerIndex: number }[];
}): (QuizMetaItem | QuestionItem)[] {
  const items: (QuizMetaItem | QuestionItem)[] = [];
  const meta: QuizMetaItem = {
    pk: `QUIZ#${quiz.quizId}`,
    sk: 'META',
    type: 'META',
    quizId: quiz.quizId,
    title: quiz.title,
    questionCount: quiz.questions.length,
  };
  items.push(meta);

  quiz.questions.forEach((q, idx) => {
    items.push({
      pk: `QUIZ#${quiz.quizId}`,
      sk: `Q#${idx}`,
      type: 'QUESTION',
      quizId: quiz.quizId,
      n: idx,
      text: q.text,
      options: q.options,
      answerIndex: q.answerIndex,
    });
  });
  return items;
}

/**
 * Write the sample quizzes to the table. Called on first `GET /api/quizzes`
 * when the table is empty. Idempotent enough for a demo: it simply
 * (re)writes the sample items.
 */
async function seedSampleData(): Promise<void> {
  const requests: { PutRequest: { Item: QuizMetaItem | QuestionItem } }[] = [];

  for (const quiz of SAMPLE_QUIZZES) {
    for (const item of buildQuizItems(quiz)) {
      requests.push({ PutRequest: { Item: item } });
    }
  }

  // BatchWrite accepts up to 25 items per request.
  const chunkSize = 25;
  const table = tableName();
  for (let i = 0; i < requests.length; i += chunkSize) {
    const chunk = requests.slice(i, i + chunkSize);
    // `RequestItems` is typed loosely here so it can also hold the
    // `UnprocessedItems` returned by the SDK on retry.
    let requestItems: NonNullable<
      ConstructorParameters<typeof BatchWriteCommand>[0]['RequestItems']
    > = { [table]: chunk };
    // Retry UnprocessedItems with a small bounded backoff so a throttled
    // seed does not leave the table half-populated.
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await ddb.send(
        new BatchWriteCommand({ RequestItems: requestItems }),
      );
      const unprocessed = res.UnprocessedItems ?? {};
      if (!unprocessed[table] || unprocessed[table].length === 0) {
        break;
      }
      requestItems = unprocessed;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Return all quiz META items, seeding sample data if the table is empty. */
async function listQuizzes(): Promise<QuizMetaItem[]> {
  const scan = await ddb.send(
    new ScanCommand({
      TableName: tableName(),
      FilterExpression: '#sk = :meta',
      ExpressionAttributeNames: { '#sk': 'sk' },
      ExpressionAttributeValues: { ':meta': 'META' },
    }),
  );

  let metas = (scan.Items ?? []) as QuizMetaItem[];
  if (metas.length === 0) {
    await seedSampleData();
    metas = SAMPLE_QUIZZES.map((q) => ({
      pk: `QUIZ#${q.quizId}`,
      sk: 'META',
      type: 'META',
      quizId: q.quizId,
      title: q.title,
      questionCount: q.questions.length,
    }));
  }
  return metas;
}

/** Return all items (meta + questions) for a single quiz. */
async function getQuizItems(
  quizId: string,
): Promise<{ meta?: QuizMetaItem; questions: QuestionItem[] }> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': `QUIZ#${quizId}` },
    }),
  );

  const items = (res.Items ?? []) as (QuizMetaItem | QuestionItem)[];
  let meta: QuizMetaItem | undefined;
  const questions: QuestionItem[] = [];
  for (const item of items) {
    if (item.sk === 'META') {
      meta = item as QuizMetaItem;
    } else if (item.type === 'QUESTION') {
      questions.push(item as QuestionItem);
    }
  }
  questions.sort((a, b) => a.n - b.n);
  return { meta, questions };
}

/** Persist a new quiz (META + Q#n items) via BatchWrite (<= 25 per call). */
async function writeQuizItems(quiz: NormalizedQuiz): Promise<void> {
  const items = buildQuizItems(quiz);
  const table = tableName();
  const chunkSize = 25;
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    let requestItems: NonNullable<
      ConstructorParameters<typeof BatchWriteCommand>[0]['RequestItems']
    > = { [table]: chunk.map((Item) => ({ PutRequest: { Item } })) };
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await ddb.send(
        new BatchWriteCommand({ RequestItems: requestItems }),
      );
      const unprocessed = res.UnprocessedItems ?? {};
      if (!unprocessed[table] || unprocessed[table].length === 0) {
        break;
      }
      requestItems = unprocessed;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * Delete every item (META + all Q#n) belonging to a single quiz.
 *
 * DynamoDB's DocumentClient has no "delete by key prefix", so we first
 * learn the exact keys via getQuizItems (a Query on pk=QUIZ#<quizId>),
 * then issue BatchWrite DeleteRequests in chunks of <= 25 using the SAME
 * UnprocessedItems bounded-retry pattern as writeQuizItems/seedSampleData.
 * Key shapes are kept identical (pk=`QUIZ#${quizId}`, sk='META' | `Q#${n}`).
 */
async function deleteQuizItems(quizId: string): Promise<void> {
  const { meta, questions } = await getQuizItems(quizId);

  const keys: { pk: string; sk: string }[] = [];
  if (meta) {
    keys.push({ pk: meta.pk, sk: meta.sk });
  }
  for (const q of questions) {
    keys.push({ pk: q.pk, sk: q.sk });
  }
  if (keys.length === 0) {
    return;
  }

  const table = tableName();
  const chunkSize = 25;
  for (let i = 0; i < keys.length; i += chunkSize) {
    const chunk = keys.slice(i, i + chunkSize);
    let requestItems: NonNullable<
      ConstructorParameters<typeof BatchWriteCommand>[0]['RequestItems']
    > = { [table]: chunk.map((Key) => ({ DeleteRequest: { Key } })) };
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await ddb.send(
        new BatchWriteCommand({ RequestItems: requestItems }),
      );
      const unprocessed = res.UnprocessedItems ?? {};
      if (!unprocessed[table] || unprocessed[table].length === 0) {
        break;
      }
      requestItems = unprocessed;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/**
 * Emit a small audit line for an authenticated admin call. API Gateway has
 * already validated the Cognito JWT before the Lambda runs, so the caller's
 * subject/username is read from the request context claims when available.
 */
function logAdminCaller(event: APIGatewayProxyEventV2, action: string): void {
  const claims = (
    event.requestContext as {
      authorizer?: { jwt?: { claims?: Record<string, unknown> } };
    }
  ).authorizer?.jwt?.claims;
  if (claims) {
    // eslint-disable-next-line no-console
    console.log(action, 'by', claims.sub ?? claims.username ?? 'unknown');
  }
}

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const routeKey = event.routeKey;
    const quizId = event.pathParameters?.quizId;

    if (routeKey === 'GET /api/quizzes') {
      const metas = await listQuizzes();
      const quizzes = metas
        .map((m) => ({
          quizId: m.quizId,
          title: m.title,
          questionCount: m.questionCount,
        }))
        .sort((a, b) => a.quizId.localeCompare(b.quizId));
      return json(200, { quizzes });
    }

    if (routeKey === 'GET /api/quizzes/{quizId}') {
      if (!quizId) {
        return json(400, { message: 'quizId is required' });
      }
      const { meta, questions } = await getQuizItems(quizId);
      if (!meta) {
        return json(404, { message: 'quiz not found' });
      }
      // Strip answerIndex so the client cannot cheat.
      const sanitized = toPublicQuestions(questions);
      return json(200, {
        quizId: meta.quizId,
        title: meta.title,
        questions: sanitized,
      });
    }

    if (routeKey === 'POST /api/quizzes/{quizId}/submit') {
      if (!quizId) {
        return json(400, { message: 'quizId is required' });
      }
      let parsed: unknown;
      try {
        parsed = event.body ? JSON.parse(event.body) : {};
      } catch {
        return json(400, { message: 'invalid JSON body' });
      }
      const answers = (parsed as { answers?: unknown }).answers;
      if (!Array.isArray(answers) || answers.some((a) => typeof a !== 'number')) {
        return json(400, { message: 'answers must be an array of numbers' });
      }

      const { meta, questions } = await getQuizItems(quizId);
      if (!meta) {
        return json(404, { message: 'quiz not found' });
      }

      const scored = scoreAnswers(questions, answers as number[]);

      return json(200, {
        quizId: meta.quizId,
        score: scored.score,
        total: scored.total,
        results: scored.results,
      });
    }

    if (routeKey === 'POST /api/admin/quizzes') {
      // API Gateway has already validated the Cognito JWT before invoking
      // this Lambda, so a request reaching this branch is authenticated.
      logAdminCaller(event, 'admin quiz create');

      let parsed: unknown;
      try {
        parsed = event.body ? JSON.parse(event.body) : {};
      } catch {
        return json(400, { message: 'invalid JSON body' });
      }

      const validated = validateAndNormalizeQuizInput(parsed);
      if (!validated.ok) {
        return json(400, { message: validated.error });
      }

      // Reject a collision with an existing quiz.
      const existing = await getQuizItems(validated.quiz.quizId);
      if (existing.meta) {
        return json(409, { message: 'quiz already exists' });
      }

      await writeQuizItems(validated.quiz);

      return json(201, {
        quizId: validated.quiz.quizId,
        title: validated.quiz.title,
        questionCount: validated.quiz.questions.length,
      });
    }

    if (routeKey === 'GET /api/admin/quizzes/{quizId}') {
      logAdminCaller(event, 'admin quiz read');
      if (!quizId) {
        return json(400, { message: 'quizId is required' });
      }
      const { meta, questions } = await getQuizItems(quizId);
      if (!meta) {
        return json(404, { message: 'quiz not found' });
      }
      // Admin read: INCLUDE answerIndex (do NOT strip) so the editor can
      // pre-fill the correct answer. Questions are already sorted by n.
      return json(200, {
        quizId: meta.quizId,
        title: meta.title,
        questions: questions.map((q) => ({
          n: q.n,
          text: q.text,
          options: q.options,
          answerIndex: q.answerIndex,
        })),
      });
    }

    if (routeKey === 'PUT /api/admin/quizzes/{quizId}') {
      logAdminCaller(event, 'admin quiz update');
      if (!quizId) {
        return json(400, { message: 'quizId is required' });
      }
      let parsed: unknown;
      try {
        parsed = event.body ? JSON.parse(event.body) : {};
      } catch {
        return json(400, { message: 'invalid JSON body' });
      }

      const validated = validateAndNormalizeQuizUpdate(parsed, quizId);
      if (!validated.ok) {
        return json(400, { message: validated.error });
      }

      // Edit (not create): the quiz must already exist.
      const existing = await getQuizItems(quizId);
      if (!existing.meta) {
        return json(404, { message: 'quiz not found' });
      }

      // Full-replace: drop all existing items then write the new payload so
      // META.questionCount and the Q#n items reflect the new quiz exactly.
      await deleteQuizItems(quizId);
      await writeQuizItems(validated.quiz);

      return json(200, {
        quizId: validated.quiz.quizId,
        title: validated.quiz.title,
        questionCount: validated.quiz.questions.length,
      });
    }

    if (routeKey === 'DELETE /api/admin/quizzes/{quizId}') {
      logAdminCaller(event, 'admin quiz delete');
      if (!quizId) {
        return json(400, { message: 'quizId is required' });
      }
      const { meta } = await getQuizItems(quizId);
      if (!meta) {
        return json(404, { message: 'quiz not found' });
      }
      await deleteQuizItems(quizId);
      return json(200, { quizId, deleted: true });
    }

    return json(404, { message: 'not found' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('handler error', err);
    return json(500, { message: 'internal server error' });
  }
};
