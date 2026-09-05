// API のベース URL。
//
// `cdk deploy` 後、CfnOutput の `ApiEndpoint` (例: https://xxxx.execute-api.<region>.amazonaws.com)
// の値をここに設定してから S3 に再デプロイしてください。
// 空文字の場合は同一オリジンの相対パスにフォールバックします。
window.API_BASE = '';
