// Cognito Hosted UI（implicit grant）のヘルパー。旧 admin.js を正確にミラーする。
// sessionStorage キー、60 秒のマージン、3600 秒の既定、history.replaceState での
// フラグメント除去まで挙動を一致させる。

import { COGNITO_DOMAIN, COGNITO_CLIENT_ID } from './config';

export const STORAGE_KEY = 'quizAdminToken';

/** メモリ・sessionStorage に保持するトークン情報。 */
export interface StoredToken {
  idToken: string;
  expiresAt: number;
}

/** ハッシュ解析の結果。error は OAuth のエラーパラメータ。 */
export interface CaptureResult {
  idToken?: string;
  expiresAt?: number;
  error?: string;
}

/**
 * captureTokenFromHash() の history.replaceState 用にのみ使う、現在ページの URL。
 * クエリやハッシュを除いた origin + pathname。
 *
 * 注意: これはもはや OAuth の redirect_uri には使わない。redirect_uri は Cognito に
 * 登録された正準な文字列（adminRedirectUri() / publicRedirectUri()）でなければならず、
 * ブラウザが実際に着地したページに依らず byte-for-byte で一致する必要がある。
 * ここでは「トークン取得後に現在の URL からフラグメントを取り除く」目的にのみ使う。
 */
export function adminPageUrl(): string {
  return window.location.origin + window.location.pathname;
}

/**
 * Cognito に登録された正準な redirect_uri を返すヘルパー。
 *
 * 重要: これらの文字列は lib/quiz-app-stack.ts の callbackUrls / logoutUrls に
 * 登録された値と byte-for-byte（scheme, host, path, 末尾スラッシュ）で一致させること。
 * Cognito は redirect_uri の完全一致を要求するため、少しでもズレると
 * redirect_mismatch になる。
 *
 * - 管理画面は Amplify が `/admin.html` で配信する => origin + '/admin.html'。
 * - 公開アプリ（リアルタイム対戦ホストを含む）は Amplify が ROOT で配信するため、
 *   リダイレクト後にブラウザが着地するのは origin + '/'（末尾スラッシュ付き、
 *   '/index.html' ではない）。したがってホストの redirect_uri は origin + '/'。
 */
export function adminRedirectUri(): string {
  return window.location.origin + '/admin.html';
}

/** 公開アプリ（リアルタイム対戦ホスト）用の正準な redirect_uri（ROOT）。 */
export function publicRedirectUri(): string {
  return window.location.origin + '/';
}

/** Cognito Hosted UI のログイン URL。redirectUri は登録済みの正準文字列を渡すこと。 */
export function loginUrl(redirectUri: string): string {
  return (
    COGNITO_DOMAIN +
    '/login?client_id=' +
    encodeURIComponent(COGNITO_CLIENT_ID) +
    '&response_type=token' +
    '&scope=openid+email+profile' +
    '&redirect_uri=' +
    encodeURIComponent(redirectUri)
  );
}

/** Cognito Hosted UI のログアウト URL。redirectUri は登録済みの正準文字列を渡すこと。 */
export function logoutUrl(redirectUri: string): string {
  return (
    COGNITO_DOMAIN +
    '/logout?client_id=' +
    encodeURIComponent(COGNITO_CLIENT_ID) +
    '&logout_uri=' +
    encodeURIComponent(redirectUri)
  );
}

/**
 * sessionStorage から有効なトークンを復元する。期限切れなら削除して null。
 * sessionStorage が使えない環境でも動くよう try/catch でガードする。
 */
export function restoreToken(): StoredToken | null {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const saved = JSON.parse(raw) as Partial<StoredToken>;
    if (
      saved &&
      typeof saved.idToken === 'string' &&
      typeof saved.expiresAt === 'number' &&
      Date.now() < saved.expiresAt
    ) {
      return { idToken: saved.idToken, expiresAt: saved.expiresAt };
    }
    window.sessionStorage.removeItem(STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

/** トークンを sessionStorage に保存する。 */
export function saveToken(idToken: string, expiresAt: number): void {
  try {
    window.sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ idToken, expiresAt }),
    );
  } catch {
    // 保存できなくてもメモリ上のトークンで動作する。
  }
}

/** 保存済みトークンを削除する。 */
export function clearToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // no-op
  }
}

/**
 * URL フラグメント（#id_token=...&expires_in=...）を解析する。
 * implicit grant のトークンを取得したら保存し、フラグメントを URL から除去する。
 * 60 秒のマージンを取り、expires_in が無効/未指定なら 3600 秒を既定にする。
 */
export function captureTokenFromHash(): CaptureResult {
  let hash = window.location.hash || '';
  if (hash.charAt(0) === '#') {
    hash = hash.substring(1);
  }
  if (!hash) {
    return {};
  }

  const params = new URLSearchParams(hash);
  const token = params.get('id_token');
  const expiresIn = params.get('expires_in');
  const oauthError = params.get('error');

  const result: CaptureResult = {};
  if (oauthError) {
    result.error = oauthError;
  }

  if (token) {
    let seconds = expiresIn ? parseInt(expiresIn, 10) : 3600;
    if (isNaN(seconds) || seconds <= 0) {
      seconds = 3600;
    }
    // 時計ずれ・遅延を考慮し 60 秒のマージンを取る。
    const expiresAt = Date.now() + (seconds - 60) * 1000;
    saveToken(token, expiresAt);
    result.idToken = token;
    result.expiresAt = expiresAt;
  }

  if (token || oauthError) {
    // フラグメントを消してトークンを URL から見えなくする。
    history.replaceState(null, '', adminPageUrl() + window.location.search);
  }

  return result;
}
