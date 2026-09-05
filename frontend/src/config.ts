// ランタイム設定。Vite のビルド時に import.meta.env.VITE_* から注入される。
// 旧 app.js / admin.js の window.API_BASE / window.COGNITO_* と同じ規約を踏襲する。
//
// 本番では Amplify のビルドが frontend/.env を生成し、以下の 3 変数を注入する
// （amplify.yml が API_BASE -> VITE_API_BASE などにマッピングする）。

// API のベース URL。末尾スラッシュは除去。未設定（空文字）の場合は同一オリジン
// `/api` を既定とする（旧 app.js と同じフォールバック）。
export const API_BASE = (
  import.meta.env.VITE_API_BASE && import.meta.env.VITE_API_BASE !== ''
    ? import.meta.env.VITE_API_BASE
    : '/api'
).replace(/\/$/, '');

// Cognito Hosted UI のベース URL。末尾スラッシュは除去。
export const COGNITO_DOMAIN = (import.meta.env.VITE_COGNITO_DOMAIN ?? '').replace(
  /\/$/,
  '',
);

// Cognito のパブリックアプリクライアント ID。
export const COGNITO_CLIENT_ID = import.meta.env.VITE_COGNITO_CLIENT_ID ?? '';

// リアルタイム対戦の WebSocket エンドポイント（wss://...）。末尾スラッシュは除去。
// CDK CfnOutput の WebSocketEndpoint を Amplify 環境変数 WS_URL に設定し、
// amplify.yml が WS_URL -> VITE_WS_URL にマッピングする。未設定なら空文字。
export const WS_URL = (import.meta.env.VITE_WS_URL ?? '').replace(/\/$/, '');
