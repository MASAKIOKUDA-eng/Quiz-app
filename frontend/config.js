// API のベース URL。
//
// このアプリは CloudFront の `/api/*` ビヘイビアを通じて、SPA と同一オリジンで
// HTTP API を呼び出します。そのため既定値は `/api` で、`cdk deploy` 後に手動で
// 値を書き換える必要はありません（そのまま動作します）。
//
// もし API を別オリジン（例: execute-api の URL 直叩き）で呼びたい場合のみ、
// ここを `https://xxxx.execute-api.<region>.amazonaws.com/api` のように設定できます。
window.API_BASE = '/api';
