// API のベース URL。
//
// このアプリは CloudFront の `/api/*` ビヘイビアを通じて、SPA と同一オリジンで
// HTTP API を呼び出します。そのため既定値は `/api` で、`cdk deploy` 後に手動で
// 値を書き換える必要はありません（そのまま動作します）。
//
// もし API を別オリジン（例: execute-api の URL 直叩き）で呼びたい場合のみ、
// ここを `https://xxxx.execute-api.<region>.amazonaws.com/api` のように設定できます。
window.API_BASE = '/api';

// 管理者ページ（admin.html）用の Cognito Hosted UI 設定。
//
// これらの値は CDK の CfnOutputs から取得します:
//   - COGNITO_DOMAIN     = UserPoolHostedUiDomain（Hosted UI のベース URL。
//                          例: https://<prefix>.auth.<region>.amazoncognito.com）
//   - COGNITO_CLIENT_ID  = UserPoolClientId（パブリックなアプリクライアント ID）
//
// FEAT-004 の Amplify Hosting では、これらは Amplify の環境変数から
// ビルド時に config.js へ注入される想定です。ローカルや手動デプロイで
// 管理者ページを使う場合は、下記を実際の値に書き換えてください。
window.COGNITO_DOMAIN = '';
window.COGNITO_CLIENT_ID = '';
