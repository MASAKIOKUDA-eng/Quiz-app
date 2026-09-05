// このファイルはローカル開発用のプレースホルダーです。
// 本番（Amplify Hosting）では、amplify.yml のビルドが Amplify の環境変数から
// このファイルを丸ごと上書きして生成します（値は下記参照）。手動編集は不要です。

// API のベース URL。
//
// フロントエンドは Amplify Hosting から配信され、API Gateway の HTTP API とは
// 別オリジンになります（クロスオリジン呼び出し）。そのため API_BASE には
// API エンドポイントのフル URL（末尾に /api）を設定します。
//   例: https://xxxx.execute-api.<region>.amazonaws.com/api
// この値は CDK CfnOutput の ApiEndpoint に '/api' を付けたものです。
// Amplify では環境変数 $API_BASE からビルド時に注入されます。
//
// ローカルで直接開く場合は、下記を実際の API エンドポイント + '/api' に
// 書き換えてください（空文字のままだと同一オリジンの '/api' を既定にします）。
window.API_BASE = '';

// 管理者ページ（admin.html）用の Cognito Hosted UI 設定。
//
// これらの値は CDK の CfnOutputs から取得します:
//   - COGNITO_DOMAIN     = UserPoolHostedUiDomain（Hosted UI のベース URL。
//                          例: https://<prefix>.auth.<region>.amazoncognito.com）
//   - COGNITO_CLIENT_ID  = UserPoolClientId（パブリックなアプリクライアント ID）
//
// Amplify Hosting では、これらは Amplify の環境変数 $COGNITO_DOMAIN /
// $COGNITO_CLIENT_ID からビルド時に config.js へ注入されます。ローカルや
// 手動デプロイで管理者ページを使う場合は、下記を実際の値に書き換えてください。
window.COGNITO_DOMAIN = '';
window.COGNITO_CLIENT_ID = '';
