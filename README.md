# Quiz App (サーバーレス クイズ出題アプリ)

AWS 上でフルサーバーレスに動作する、クイズ出題アプリケーションです。インフラは
[AWS CDK v2 (TypeScript)](https://docs.aws.amazon.com/cdk/) で定義しています。

「**利用コストは最低限**」「**常時動かすためにサーバーレス**」という要件に合わせ、
アイドル時に料金が発生しない（ゼロにスケールする）マネージドサービスのみで構成しています。

---

## 概要

- 複数のクイズから 1 つを選び、選択式の問題に回答すると採点結果が返ります。
- 正解データ (`answerIndex`) は API レスポンスから除外され、クライアント側では
  答えが見えないようになっています。採点はサーバー側 (Lambda) で行います。
- フロントエンドは静的な SPA（バニラ JS）で、CloudFront + 非公開 S3 バケットから配信します。
- 初回の `GET /quizzes` 実行時、DynamoDB が空であればサンプルクイズ（日本語 2 種、各 3 問）を自動投入します。

---

## アーキテクチャ

```
[ブラウザ / SPA]
      │  HTTPS
      ▼
[CloudFront (PriceClass_100, OAC)]
      │  ├── 静的アセット ──► [S3 バケット (非公開 / BlockPublicAccess ALL)]
      │
      ▼  /quizzes などの API 呼び出し
[API Gateway HTTP API (v2)]
      │
      ▼
[AWS Lambda (Node.js 22, ARM64 / Graviton)]
      │
      ▼
[Amazon DynamoDB (オンデマンド / PAY_PER_REQUEST)]
```

- **フロントエンド**: 非公開 S3 バケット + CloudFront（Origin Access Control）。SPA ルーティングのため 403/404 を `index.html` に返します。
- **API**: API Gateway HTTP API (v2)。REST API より安価。
  - `GET /quizzes` — クイズ一覧
  - `GET /quizzes/{quizId}` — 指定クイズの設問（正解は除外）
  - `POST /quizzes/{quizId}/submit` — 回答を採点して結果を返す
- **バックエンド**: 単一の Lambda 関数（Node.js 22, ARM64）。
- **データストア**: DynamoDB シングルテーブル、オンデマンド課金。

---

## 利用コストを最低限にするための設計 (コスト最適化)

このアプリは「常時稼働しているように見えて、待機中は課金されない」ことを目指しています。
各サービスの選定理由は次のとおりです。

| 選択 | コスト面の理由 |
| --- | --- |
| **DynamoDB オンデマンド (PAY_PER_REQUEST)** | プロビジョニング済みキャパシティを持たないため、**アイドル時の固定料金がゼロ**。リクエスト単位の従量課金。 |
| **AWS Lambda (ARM64 / Graviton)** | 呼び出し回数と実行時間のみの課金で、**リクエストが無ければ料金は発生せずゼロにスケール**。ARM64 は x86 より単価が安い。メモリ 256 MB / タイムアウト 10 秒に抑制。 |
| **API Gateway HTTP API (v2)** | 同等の REST API より**リクエスト単価が安い**。 |
| **CloudFront `PriceClass_100`** | 北米・欧州のエッジのみを使う最安のプライスクラス。データ転送コストを抑制。 |
| **非公開 S3 + 静的ホスティング** | ストレージ・転送とも非常に低コスト（月数円〜）。常時起動のサーバー不要。 |
| **VPC / NAT ゲートウェイ なし** | NAT ゲートウェイは**アイドルでも時間課金**が発生するため使用しない。 |
| **EC2 / RDS などの常時起動リソース なし** | 24 時間課金される計算・DB リソースを一切使わない。 |
| **Cognito なし（公開クイズ）** | 認証を省くことで構成と料金を最小化（必要なら後述の follow-up で追加可能）。 |

要するに、**待機中（誰もアクセスしていない時間）の課金がほぼ発生しない**構成です。
料金が増えるのはアクセス（リクエスト）が来たときだけで、実質的な下限コストは
S3 ストレージと CloudFront の最低限の転送のみです。

---

## 前提条件 (Prerequisites)

- **Node.js 22** 以上 と npm
- **AWS 認証情報**（`aws configure` などで設定済み、デプロイ権限を持つこと）
- 対象アカウント/リージョンで **CDK ブートストラップ**が未実施なら 1 回だけ実行が必要

---

## デプロイ手順 (Deploy)

> **重要:** 本プロジェクトは **ネットワーク非接続のサンドボックスで作成**されました。
> そのため `npm install` / `npm run build` / `npm test` / `npx cdk synth` / `npx cdk deploy` は
> **この環境では実行されていません**。以下のコマンドは、依存関係をインストールできる
> ネットワーク接続環境で**運用者が実行**してください。

```bash
# 1. 依存関係のインストール
npm install

# 2. TypeScript のビルド (tsc)
npm run build

# 3. テスト (CDK アサーション + Lambda 採点ロジックの単体テスト)
npm test

# 4. CloudFormation テンプレートの合成 (任意・確認用)
npx cdk synth

# 5. 初回のみ: アカウント/リージョンのブートストラップ
npx cdk bootstrap

# 6. デプロイ
npx cdk deploy
```

デプロイが完了すると、次の CfnOutput が表示されます。

- `ApiEndpoint` — HTTP API のベース URL
- `CloudFrontDomain` — SPA を配信する CloudFront ドメイン
- `TableName` — DynamoDB テーブル名

### フロントエンドの API ベース URL を設定する

SPA は `frontend/config.js` の `window.API_BASE` を参照します。デプロイ後に
出力された `ApiEndpoint` の値を設定してから、S3 へ再デプロイしてください。

```js
// frontend/config.js
window.API_BASE = 'https://xxxx.execute-api.<region>.amazonaws.com';
```

値を書き換えたあと、再度 `npx cdk deploy` を実行すると `BucketDeployment` により
更新後のアセットが S3 に配置され、CloudFront のキャッシュが無効化されます。

その後、`CloudFrontDomain` の URL にブラウザでアクセスするとアプリが利用できます。

---

## 破棄 (Teardown)

不要になったら、以下ですべてのリソースを削除できます（料金の発生を止められます）。

```bash
npx cdk destroy
```

S3 バケットと DynamoDB テーブルは `RemovalPolicy.DESTROY` を設定しているため、
スタック削除時に一緒に削除されます。

---

## 検証コマンド (ネットワーク接続環境で実行)

本リポジトリはネットワーク非接続環境で作成されたため、下記が
**フル検証のためのコマンド**です。接続環境で実行してください。

```bash
env -u NODE_OPTIONS npm install
env -u NODE_OPTIONS npm run build
env -u NODE_OPTIONS npm test
env -u NODE_OPTIONS npx cdk synth
```

> 注: 一部のサンドボックス環境では壊れた `NODE_OPTIONS` を回避するため、
> node/npm/npx コマンドの前に `env -u NODE_OPTIONS` を付ける必要があります。
> 通常の環境ではこの接頭辞は不要です。

---

## テストについて

- `test/quiz-app-stack.test.ts` — `aws-cdk-lib/assertions` の `Template` を使い、
  スタックをメモリ内で合成して次を検証します: DynamoDB がオンデマンド課金であること、
  Lambda が ARM64 + Node ランタイムであること、HTTP API であること、3 つのルートが
  存在すること、CloudFront が `PriceClass_100` であること、S3 バケットがパブリック
  アクセスを完全にブロックしていること。
- `test/handler.test.ts` — Lambda ソースから **実際にエクスポートされている純粋関数**
  `scoreAnswers` を import して採点ロジックを検証します（全問正解・部分正解・空/長さ不一致・
  範囲外インデックスなど）。実運用コードをそのまま呼ぶため、採点ロジックが壊れれば
  テストは失敗します。

---

## 今後の拡張候補 (Optional follow-ups)

- **認証**: Amazon Cognito を追加し、ユーザー毎のスコア保存やアクセス制御を行う。
- **カスタムドメイン**: Route 53 + ACM 証明書で独自ドメイン + HTTPS を構成する。
- **CI/CD**: GitHub Actions などで `npm test` と `cdk deploy` を自動化する。
