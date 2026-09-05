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

const JSON_HEADERS = {
  'content-type': 'application/json',
  'access-control-allow-origin': '*',
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
 * Write the sample quizzes to the table. Called on first `GET /quizzes`
 * when the table is empty. Idempotent enough for a demo: it simply
 * (re)writes the sample items.
 */
async function seedSampleData(): Promise<void> {
  const requests: { PutRequest: { Item: QuizMetaItem | QuestionItem } }[] = [];

  for (const quiz of SAMPLE_QUIZZES) {
    const meta: QuizMetaItem = {
      pk: `QUIZ#${quiz.quizId}`,
      sk: 'META',
      type: 'META',
      quizId: quiz.quizId,
      title: quiz.title,
      questionCount: quiz.questions.length,
    };
    requests.push({ PutRequest: { Item: meta } });

    quiz.questions.forEach((q, idx) => {
      const item: QuestionItem = {
        pk: `QUIZ#${quiz.quizId}`,
        sk: `Q#${idx}`,
        type: 'QUESTION',
        quizId: quiz.quizId,
        n: idx,
        text: q.text,
        options: q.options,
        answerIndex: q.answerIndex,
      };
      requests.push({ PutRequest: { Item: item } });
    });
  }

  // BatchWrite accepts up to 25 items per request.
  const chunkSize = 25;
  for (let i = 0; i < requests.length; i += chunkSize) {
    const chunk = requests.slice(i, i + chunkSize);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: { [tableName()]: chunk },
      }),
    );
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

export const handler = async (
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyResultV2> => {
  try {
    const routeKey = event.routeKey;
    const quizId = event.pathParameters?.quizId;

    if (routeKey === 'GET /quizzes') {
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

    if (routeKey === 'GET /quizzes/{quizId}') {
      if (!quizId) {
        return json(400, { message: 'quizId is required' });
      }
      const { meta, questions } = await getQuizItems(quizId);
      if (!meta) {
        return json(404, { message: 'quiz not found' });
      }
      // Strip answerIndex so the client cannot cheat.
      const sanitized = questions.map((q) => ({
        n: q.n,
        text: q.text,
        options: q.options,
      }));
      return json(200, {
        quizId: meta.quizId,
        title: meta.title,
        questions: sanitized,
      });
    }

    if (routeKey === 'POST /quizzes/{quizId}/submit') {
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

    return json(404, { message: 'not found' });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('handler error', err);
    return json(500, { message: 'internal server error' });
  }
};
