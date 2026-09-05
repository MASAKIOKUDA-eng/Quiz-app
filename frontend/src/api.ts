// 型付き API クライアント。バックエンド（lambda/index.ts）の契約を正確にミラーする。
// 旧 frontend/app.js / admin.js の fetch セマンティクスをそのまま踏襲する。

import { API_BASE } from './config';

// ---- API の型定義（lambda/index.ts と一致させる） ----------------------

/** GET /quizzes のクイズ要約。 */
export interface QuizSummary {
  quizId: string;
  title: string;
  questionCount: number;
}

/** GET /quizzes のレスポンス。 */
export interface QuizListResponse {
  quizzes: QuizSummary[];
}

/** 公開用の設問（answerIndex はサーバーで除外される）。 */
export interface PublicQuestion {
  n: number;
  text: string;
  options: string[];
}

/** GET /quizzes/{quizId} のレスポンス。 */
export interface QuizDetail {
  quizId: string;
  title: string;
  questions: PublicQuestion[];
}

/** POST /quizzes/{quizId}/submit のレスポンス（submit は answerIndex を返す）。 */
export interface SubmitResult {
  quizId: string;
  score: number;
  total: number;
  results: { n: number; correct: boolean; answerIndex: number }[];
}

/** 管理者クイズ登録の設問入力。 */
export interface AdminQuestionInput {
  text: string;
  options: string[];
  answerIndex: number;
}

/** POST /admin/quizzes のリクエストボディ。 */
export interface CreateQuizInput {
  title: string;
  questions: AdminQuestionInput[];
  quizId?: string;
}

/** POST /admin/quizzes のレスポンス。 */
export interface CreateQuizResponse {
  quizId: string;
  title: string;
  questionCount: number;
}

/**
 * 管理者向け設問（GET /admin/quizzes/{quizId} が返す）。編集画面のプリフィル用に
 * answerIndex を含む（公開用 PublicQuestion とは異なり正解を隠さない）。
 */
export interface AdminQuestion {
  n: number;
  text: string;
  options: string[];
  answerIndex: number;
}

/** GET /admin/quizzes/{quizId} のレスポンス。 */
export interface AdminQuizDetail {
  quizId: string;
  title: string;
  questions: AdminQuestion[];
}

/** PUT /admin/quizzes/{quizId} のリクエストボディ（全置換）。 */
export interface UpdateQuizInput {
  title: string;
  questions: AdminQuestionInput[];
}

/** PUT /admin/quizzes/{quizId} のレスポンス。 */
export interface UpdateQuizResponse {
  quizId: string;
  title: string;
  questionCount: number;
}

/** DELETE /admin/quizzes/{quizId} のレスポンス。 */
export interface DeleteQuizResponse {
  quizId: string;
  deleted: boolean;
}

// ---- エラー型 -----------------------------------------------------------

/**
 * 認証エラー（401）。UI はこれを捕捉してトークンをクリアし、再ログインを促す。
 */
export class AuthError extends Error {
  constructor(message = 'ログインが必要です（認証エラー）') {
    super(message);
    this.name = 'AuthError';
  }
}

const UNEXPECTED_NON_JSON =
  'API から予期しない応答を受け取りました（JSON ではありません）。' +
  'API のルーティング設定を確認してください。';

// ---- 低レベル fetch ヘルパー -------------------------------------------

function apiUrl(path: string): string {
  return API_BASE + path;
}

/**
 * 旧 app.js の fetchJson を踏襲。res.ok を確認し、content-type が
 * application/json かどうかを防御的にチェックする（クロスオリジンでの
 * 設定ミスに備える）。
 */
async function fetchJson<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), options);
  if (!res.ok) {
    throw new Error('リクエストに失敗しました (' + res.status + ')');
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType.indexOf('application/json') === -1) {
    throw new Error(UNEXPECTED_NON_JSON);
  }
  return res.json() as Promise<T>;
}

// ---- 公開 API -----------------------------------------------------------

/** クイズ一覧を取得する。 */
export async function getQuizzes(): Promise<QuizListResponse> {
  return fetchJson<QuizListResponse>('/quizzes');
}

/** 1 つのクイズ（設問付き）を取得する。 */
export async function getQuiz(quizId: string): Promise<QuizDetail> {
  return fetchJson<QuizDetail>('/quizzes/' + encodeURIComponent(quizId));
}

/**
 * 回答を送信して採点結果を取得する。answers は設問の n をインデックスとした
 * 選択肢番号の配列（未回答は -1）。
 */
export async function submitAnswers(
  quizId: string,
  answers: number[],
): Promise<SubmitResult> {
  return fetchJson<SubmitResult>(
    '/quizzes/' + encodeURIComponent(quizId) + '/submit',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers }),
    },
  );
}

// ---- 管理者 API ---------------------------------------------------------

/**
 * 認証付き管理者リクエストの共通ヘルパー。旧 admin.js の postJson の
 * ステータス処理を全メソッド共通でミラーする:
 *   - Authorization: Bearer <idToken> を必ず付与する
 *   - body がある場合のみ content-type: application/json を付与し JSON 送信する
 *   - 401 -> AuthError（UI がトークンをクリアして再ログイン）
 *   - 403 -> Error('権限がありません')
 *   - その他の非 ok -> JSON ボディの message を優先、なければ汎用メッセージ
 *   - ok だが JSON でない -> 予期しない応答メッセージ
 */
async function adminRequest<T>(
  path: string,
  method: string,
  idToken: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    authorization: 'Bearer ' + idToken,
  };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }

  const res = await fetch(apiUrl(path), {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    throw new AuthError();
  }
  if (res.status === 403) {
    throw new Error('権限がありません');
  }

  const contentType = res.headers.get('content-type') || '';
  let data: unknown = null;
  if (contentType.indexOf('application/json') !== -1) {
    data = await res.json();
  }

  if (!res.ok) {
    const message =
      data && typeof data === 'object' && 'message' in data
        ? String((data as { message: unknown }).message)
        : 'リクエストに失敗しました (' + res.status + ')';
    throw new Error(message);
  }

  if (data === null) {
    throw new Error(UNEXPECTED_NON_JSON);
  }
  return data as T;
}

/**
 * 管理者としてクイズを登録する。上記 adminRequest の共通セマンティクスを用いる。
 */
export async function createQuiz(
  input: CreateQuizInput,
  idToken: string,
): Promise<CreateQuizResponse> {
  return adminRequest<CreateQuizResponse>(
    '/admin/quizzes',
    'POST',
    idToken,
    input,
  );
}

/**
 * 管理者としてクイズ（正解 answerIndex 込み）を取得する。編集画面のプリフィル用。
 * 存在しない場合はサーバーの 404 JSON message を含む Error を投げる。
 */
export async function getAdminQuiz(
  quizId: string,
  idToken: string,
): Promise<AdminQuizDetail> {
  return adminRequest<AdminQuizDetail>(
    '/admin/quizzes/' + encodeURIComponent(quizId),
    'GET',
    idToken,
  );
}

/**
 * 管理者としてクイズを全置換で更新する（PUT）。body の quizId は無視され、
 * パスの quizId が優先される。存在しない場合は 404 の message を投げる。
 */
export async function updateQuiz(
  quizId: string,
  input: UpdateQuizInput,
  idToken: string,
): Promise<UpdateQuizResponse> {
  return adminRequest<UpdateQuizResponse>(
    '/admin/quizzes/' + encodeURIComponent(quizId),
    'PUT',
    idToken,
    input,
  );
}

/**
 * 管理者としてクイズを削除する（DELETE、ボディなし）。存在しない場合は
 * 404 の message を投げる。
 */
export async function deleteQuiz(
  quizId: string,
  idToken: string,
): Promise<DeleteQuizResponse> {
  return adminRequest<DeleteQuizResponse>(
    '/admin/quizzes/' + encodeURIComponent(quizId),
    'DELETE',
    idToken,
  );
}
