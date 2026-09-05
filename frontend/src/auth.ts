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
 * このページ自身の URL（Hosted UI の redirect_uri / logout_uri に使う）。
 * クエリやハッシュを除いた origin + pathname。
 */
export function adminPageUrl(): string {
  return window.location.origin + window.location.pathname;
}

/** Cognito Hosted UI のログイン URL。 */
export function loginUrl(): string {
  return (
    COGNITO_DOMAIN +
    '/login?client_id=' +
    encodeURIComponent(COGNITO_CLIENT_ID) +
    '&response_type=token' +
    '&scope=openid+email+profile' +
    '&redirect_uri=' +
    encodeURIComponent(adminPageUrl())
  );
}

/** Cognito Hosted UI のログアウト URL。 */
export function logoutUrl(): string {
  return (
    COGNITO_DOMAIN +
    '/logout?client_id=' +
    encodeURIComponent(COGNITO_CLIENT_ID) +
    '&logout_uri=' +
    encodeURIComponent(adminPageUrl())
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
