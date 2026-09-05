# Quiz App (サーバーレス クイズ出題アプリ)

AWS 上でフルサーバーレスに動作する、クイズ出題アプリケーションです。インフラは
[AWS CDK v2 (TypeScript)](https://docs.aws.amazon.com/cdk/) で定義し、フロントエンドの
配信は [AWS Amplify Hosting](https://docs.aws.amazon.com/amplify/latest/userguide/welcome.html)
（Hosting のみ / バックエンドは使わない）で行います。

「**利用コストは最低限**」「**常時動かすためにサーバーレス**」という要件に合わせ、
アイドル時に料金が発生しない（ゼロにスケールする）マネージドサービスのみで構成しています。

---

## 概要

- 複数のクイズから 1 つを選び、選択式の問題に回答すると採点結果が返ります。
- デフォルトの問題は「**AWS アーキテクチャの実装を問う**」オリジナル問題です。
- 正解データ (`answerIndex`) は API レスポンスから除外され、クライアント側では
  答えが見えないようになっています。採点はサーバー側 (Lambda) で行います。
- フロントエンドは **React + Vite + TypeScript の SPA**（`frontend/` 配下の独立した npm
  プロジェクト）で、**Amplify Hosting** が npm ビルドして配信します。
- **管理者ページ（`/admin` ルート）** から、自作のクイズを登録できます。管理者認証は
  **Amazon Cognito（Hosted UI）** で行い、書き込み API は JWT オーソライザーで保護しています。
- 初回の `GET /api/quizzes` 実行時、DynamoDB が空であればデフォルトの AWS 問題を自動投入します。

---

## アーキテクチャ

```
[ブラウザ / SPA]
   │
   │  ① 静的アセット (HTML/JS/CSS) を取得
   ▼
[AWS Amplify Hosting]  ← Git リポジトリ連携 (Hosting のみ)。amplify.yml で npm ビルド。
   │                       ビルド時に環境変数から frontend/.env を生成し VITE_* に注入。
   │
   │  ② API 呼び出し（クロスオリジン / CORS）
   ▼
[API Gateway HTTP API (v2)]
   │   ├── GET  /api/quizzes                    （公開）
   │   ├── GET  /api/quizzes/{quizId}           （公開・正解は除外）
   │   ├── POST /api/quizzes/{quizId}/submit    （公開・サーバー採点）
   │   └── POST /api/admin/quizzes              （管理者のみ / JWT オーソライザー）
   │                                                    ▲
   │                                                    │ Authorization: Bearer <id_token>
   ▼                                          [Amazon Cognito User Pool + Hosted UI]
[AWS Lambda (Node.js 22, ARM64 / Graviton)]        （管理者認証。セルフサインアップは無効）
   │
   ▼
[Amazon DynamoDB (オンデマンド / PAY_PER_REQUEST)]
```

- **フロントエンド配信**: AWS Amplify Hosting。Git リポジトリを接続し、`amplify.yml` に従って
  `frontend/` で npm ビルド（Vite）を実行し、生成物 `frontend/dist` を配信します。ビルド前処理で
  Amplify の環境変数から `frontend/.env` を生成し、Vite が読む `VITE_*` に注入します。
  Amplify は **Hosting のみ**利用し、Amplify バックエンド（Gen2 等）は使いません。
- **クロスオリジン API 呼び出し（CORS）**: SPA は Amplify のドメインから配信され、API とは
  別オリジンになります。そのため HTTP API 側で CORS を有効化しています。
  - `allowMethods`: `GET` / `POST` / `OPTIONS`
  - `allowHeaders`: `content-type` と `authorization`（管理者 API が Authorization ヘッダを送るため）
  - `allowOrigins`: 本デモでは `*`。**本番では実際の Amplify ドメインに絞る**ことを推奨します
    （後述）。CORS はブラウザ側の制御であり、管理者 API は別途 Cognito JWT オーソライザーで保護されます。
- **API**: API Gateway HTTP API (v2)。REST API より安価。ルートは `/api` プレフィックス配下です。
- **管理者認証**: Amazon Cognito User Pool + Hosted UI。パブリックなアプリクライアント（クライアント
  シークレットなし）を使い、`POST /api/admin/quizzes` を JWT オーソライザーで保護します。
  セルフサインアップは無効で、管理者ユーザーは運用者が CLI/コンソールで作成します（後述）。
- **バックエンド**: 単一の Lambda 関数（Node.js 22, ARM64）。VPC / NAT は使いません。
- **データストア**: DynamoDB シングルテーブル、オンデマンド課金。

> **なぜ S3 + CloudFront をやめたか**: 以前はフロントを非公開 S3 + CloudFront で配信していましたが、
> FEAT-004 で Amplify Hosting に移行し、S3 + CloudFront は**削除**しました。理由は 2 つです。
> (1) Amplify が SPA を配信するため、同じ役割の S3 + CloudFront は冗長。
> (2) CloudFront で SPA ルーティング用に設定していた「403/404 → `index.html`(200)」の書き換えは
> ディストリビューション全体に適用され、API の正当な 4xx (JSON) まで HTML(200) に置き換えてしまう
> 問題がありました。CloudFront をやめることでこの落とし穴も解消しています。
> なお、フロントの API クライアント（`frontend/src/api.ts`）にある content-type チェックは、
> クロスオリジンでの設定ミス等に備えた防御的コードとして残しています。

---

## デフォルトの問題（AWS アーキテクチャ）

DynamoDB が空のとき、`lambda/seed-data.ts` の内容が自動投入されます。テーマは AWS の
アーキテクチャ設計・実装で、**10 問以上**のクイズを含みます。管理者ページから登録した
自作クイズは、これらと並んで一覧に表示されます。

---

## 管理者ページと自作クイズの登録フロー

1. Amplify のドメインで `/admin` を開きます（例: `https://main.<appId>.amplifyapp.com/admin`）。
   これは SPA のクライアントサイドルートです（後述の書き換えルールが必要）。
2. 「ログイン」ボタンを押すと Cognito Hosted UI にリダイレクトされ、管理者メールアドレスと
   パスワードでログインします（ユーザーは事前に運用者が作成、後述）。
3. ログイン後、タイトルと問題（各問 2〜4 個の選択肢、正解を 1 つ指定）を入力して送信します。
4. 送信は `POST /api/admin/quizzes` に `Authorization: Bearer <id_token>` 付きで行われ、
   JWT オーソライザーの検証を通過すると DynamoDB に保存されます。未認証・権限不足の場合は
   401/403 で拒否されます。
5. 登録後、トップページ（`/`）の一覧に自作クイズが表示されます。

---

## デプロイ後のセットアップ手順（順番厳守）

新規に構築する運用者は、**必ず次の順番**で作業してください。順番を飛ばすと
ログイン（Cognito のコールバック）や API 呼び出し（CORS）が**静かに壊れます**。
各コマンドの詳細は後述の「デプロイ手順」節も参照してください。

1. **CDK をデプロイして CfnOutput を控える。**
   `npx cdk deploy` を実行し、出力される次の値を控えます。
   - `ApiEndpoint` — HTTP API のベース URL
   - `UserPoolId` — Cognito User Pool ID
   - `UserPoolClientId` — Cognito アプリクライアント ID
   - `UserPoolHostedUiDomain` — Cognito Hosted UI のベース URL

2. **最初の管理者ユーザーを作成する。**
   セルフサインアップは無効なので、運用者が CLI で作成します。
   ```bash
   aws cognito-idp admin-create-user \
     --user-pool-id <UserPoolId> \
     --username admin@example.com \
     --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
     --message-action SUPPRESS

   aws cognito-idp admin-set-user-password \
     --user-pool-id <UserPoolId> \
     --username admin@example.com \
     --password 'ChangeMe!2024' \
     --permanent
   ```
   `admin-set-user-password ... --permanent` を実行しないと `FORCE_CHANGE_PASSWORD`
   状態のままで、Hosted UI から即ログインできません。

3. **Amplify Hosting に Git リポジトリを接続する（Hosting のみ）。**
   Amplify コンソールで「アプリケーションをホスト」を選び、リポジトリとブランチを
   接続します（**Amplify バックエンドは作成しません**）。次の環境変数を設定します
   （値は手順 1 の CfnOutput から）。環境変数名は従来どおりで、`amplify.yml` が
   ビルド時にこれらを Vite の `VITE_*` にマッピングします。
   - `API_BASE` = `ApiEndpoint` + `/api` → ビルドで `VITE_API_BASE` に注入
     （例: `https://xxxx.execute-api.<region>.amazonaws.com/api`）
   - `COGNITO_DOMAIN` = `UserPoolHostedUiDomain` → `VITE_COGNITO_DOMAIN`
   - `COGNITO_CLIENT_ID` = `UserPoolClientId` → `VITE_COGNITO_CLIENT_ID`
   これらの環境変数名は `amplify.yml` が参照する名前と一致している必要があります。
   さらに Amplify コンソールの「書き換えとリダイレクト」で、SPA 用にファイル以外の
   全パスを `/index.html` へ 200 で書き換えるルールを追加します（`/admin` の直接アクセス用）。
   デプロイ後、Amplify が払い出したドメイン（例: `https://main.<appId>.amplifyapp.com`）を控えます。

4. **Amplify ドメインが判明したら CDK スタックを再デプロイする。**
   `adminAppBaseUrl` パラメータに手順 3 の Amplify ドメインを渡して再デプロイし、
   Cognito アプリクライアントのコールバック/ログアウト URL に実ドメインを反映します。
   本番では `-c includeLocalhostCallback=false` も付けて、localhost へのリダイレクトを
   信頼しないようにします。
   ```bash
   npx cdk deploy \
     --parameters adminAppBaseUrl=https://main.<appId>.amplifyapp.com \
     -c includeLocalhostCallback=false
   ```
   これで `https://main.<appId>.amplifyapp.com/admin.html` が Hosted UI の
   `redirect_uri` / `logout_uri` として許可されます。
   > **注意（SPA ルート化に伴う TODO）**: React SPA では管理者ページはクライアントサイド
   > ルート `/admin` です。Cognito のコールバック/ログアウト URL は現状 CDK が `/admin.html`
   > を指すよう設定しているため、`/admin` に合わせるには CDK 側の admin ページパスの更新が
   > 必要です（フォローアップ）。当面は churn を抑えるため、Amplify の書き換えルールで
   > `/admin.html` も `/index.html` に解決させる運用も可能です。

5. **（任意・推奨）CORS の許可オリジンを絞る。**
   `lib/quiz-app-stack.ts` の `corsPreflight.allowOrigins` を実際の Amplify ドメイン
   （例: `['https://main.<appId>.amplifyapp.com']`）に絞って再デプロイします。
   本デモの既定は `*` ですが、本番では絞ることを推奨します。

> **補足:** 手順 4 を省くと Cognito のコールバック URL に Amplify ドメインが含まれず、
> ログイン後のリダイレクトが失敗します。開発中は `includeLocalhostCallback` の既定
> （`true`）により `http://localhost:8080/admin.html` が許可されますが、本番デプロイでは
> `-c includeLocalhostCallback=false` を付けて localhost を除外してください。

---

## 前提条件 (Prerequisites)

- **Node.js 22** 以上 と npm
- **AWS 認証情報**（`aws configure` などで設定済み、デプロイ権限を持つこと）
- 対象アカウント/リージョンで **CDK ブートストラップ**が未実施なら 1 回だけ実行が必要
- Amplify Hosting に接続する **Git リポジトリ**（GitHub 等）へのアクセス

---

## デプロイ手順 (Deploy)

> **重要:** 本プロジェクトは **ネットワーク非接続のサンドボックスで作成**されました。
> そのため `npm ci` / `npm run build` / `npm test` / `npx cdk synth` / `npx cdk deploy` は
> **この環境では実行されていません**。以下のコマンドは、依存関係をインストールできる
> ネットワーク接続環境で**運用者が実行**してください。

### 1. バックエンド（CDK）をデプロイ

```bash
# 依存関係のインストール
npm ci

# TypeScript のビルド (tsc)
npm run build

# テスト (CDK アサーション + Lambda 採点ロジックの単体テスト)
npm test

# CloudFormation テンプレートの合成 (任意・確認用)
npx cdk synth

# 初回のみ: アカウント/リージョンのブートストラップ
npx cdk bootstrap

# デプロイ
npx cdk deploy
```

デプロイが完了すると、次の CfnOutput が表示されます。

- `ApiEndpoint` — HTTP API のベース URL（ルートは `/api` 配下）
- `TableName` — DynamoDB テーブル名
- `UserPoolId` — Cognito User Pool ID（管理者ユーザー作成に使用）
- `UserPoolClientId` — Cognito アプリクライアント ID（パブリック／ブラウザ用）
- `UserPoolHostedUiDomain` — Cognito Hosted UI のベース URL

### 2. 最初の管理者ユーザーを作成（Cognito ブートストラップ）

セルフサインアップは無効なので、運用者が CLI で管理者ユーザーを作成します。
`<UserPoolId>` は上記 CfnOutput の値です。

```bash
# 管理者ユーザーを作成（招待メールを抑止したい場合は --message-action SUPPRESS）
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username admin@example.com \
  --user-attributes Name=email,Value=admin@example.com Name=email_verified,Value=true \
  --message-action SUPPRESS

# 恒久パスワードを設定（FORCE_CHANGE_PASSWORD を回避して即ログイン可能に）
aws cognito-idp admin-set-user-password \
  --user-pool-id <UserPoolId> \
  --username admin@example.com \
  --password 'ChangeMe!2024' \
  --permanent
```

### 3. Amplify Hosting をセットアップ（Hosting のみ）

1. Amplify コンソールで **「アプリケーションをホスト」**を選び、この Git リポジトリと
   ブランチを接続します（**Amplify バックエンドは作成しません**。Hosting のみ）。
2. ビルド設定はリポジトリの **`amplify.yml`** が使われます（`frontend/` で `npm ci`（無ければ
   `npm install`）→ `npm run build`（Vite）を実行。ビルド前に環境変数から `frontend/.env` を
   生成し `VITE_*` に注入。配信ディレクトリは `frontend/dist`）。
3. **環境変数**を設定します（値は上記 CfnOutput から）。名前は従来どおりで、`amplify.yml` が
   ビルド時に Vite の `VITE_*` へマッピングします。
   - `API_BASE` = `ApiEndpoint` + `/api` → `VITE_API_BASE`
     （例: `https://xxxx.execute-api.<region>.amazonaws.com/api`）
   - `COGNITO_DOMAIN` = `UserPoolHostedUiDomain` → `VITE_COGNITO_DOMAIN`
     （例: `https://<prefix>.auth.<region>.amazoncognito.com`）
   - `COGNITO_CLIENT_ID` = `UserPoolClientId` → `VITE_COGNITO_CLIENT_ID`
4. **SPA 書き換えルール**を Amplify コンソールの「書き換えとリダイレクト」に追加します。
   ファイル以外の全パスを `/index.html` に 200 で書き換えることで、`/admin` などの
   クライアントサイドルートへ直接アクセスできるようにします（例のソース:
   `</^[^.]+$|\.(?!(css|gif|ico|jpg|js|png|txt|svg|woff2?|json|map)$)([^.]+$)/>`、
   ターゲット: `/index.html`、種別: 200 Rewrite）。
5. デプロイ後、Amplify が払い出したドメイン（例: `https://main.<appId>.amplifyapp.com`）を控えます。

> `frontend/.env` は Amplify のビルドが環境変数から生成します（リポジトリには
> `frontend/.env.example` のみをコミットし、実値は Amplify コンソールで管理します）。

### 4. Cognito のコールバック/ログアウト URL を実ドメインに更新

Amplify のドメインが分かったら、そのドメインを Cognito アプリクライアントの
コールバック/ログアウト URL に反映します。CDK の `adminAppBaseUrl` パラメータに
Amplify ドメインを渡して再デプロイするのが簡単です。本番では
`-c includeLocalhostCallback=false` も付けて `http://localhost:8080/admin.html` を
コールバック/ログアウト URL から除外してください（既定は `true` で、ローカル開発の
利便性のため localhost を許可します）。

```bash
npx cdk deploy \
  --parameters adminAppBaseUrl=https://main.<appId>.amplifyapp.com \
  -c includeLocalhostCallback=false
```

これにより `https://main.<appId>.amplifyapp.com/admin.html` が Hosted UI の
`redirect_uri` / `logout_uri` として許可されます（コンソールから手動で更新しても可）。

> **セキュリティ推奨**: API の CORS `allowOrigins` は本デモでは `*` ですが、本番では
> `lib/quiz-app-stack.ts` の `corsPreflight.allowOrigins` を実際の Amplify ドメイン
> （例: `['https://main.<appId>.amplifyapp.com']`）に絞って再デプロイしてください。

---

## 利用開始と動作確認 (Verify)

- Amplify のドメイン（例: `https://main.<appId>.amplifyapp.com`）を開くとクイズアプリが表示されます。
- クイズを 1 つ選び、回答して採点結果が返ることを確認します（API へのクロスオリジン呼び出しが成功）。
- `/admin` を開き、Cognito Hosted UI でログイン → クイズを登録できることを確認します。
- 未ログインの状態で `POST /api/admin/quizzes` を叩くと 401/403 で拒否されることを確認します
  （例: `curl -i -X POST <ApiEndpoint>/api/admin/quizzes -d '{}'`）。

---

## フロントエンドのローカル開発 (React + Vite)

フロントエンドは `frontend/` 配下の独立した npm プロジェクトです（ルートの CDK
プロジェクトとは別。それぞれ自分の `package.json` と `node_modules` を持ちます）。

```bash
cd frontend

# 依存関係のインストール（package-lock.json は初回の install で生成されます）
npm install

# 環境変数のひな形をコピーして実値を設定
cp .env.example .env.local
# .env.local を編集し、VITE_API_BASE / VITE_COGNITO_DOMAIN / VITE_COGNITO_CLIENT_ID を設定

# 開発サーバー（既定 http://localhost:5173）
npm run dev

# 本番ビルド（tsc の型チェック + Vite バンドル。出力は frontend/dist）
npm run build
```

- `VITE_API_BASE` が空の場合は同一オリジンの `/api` が既定になります。
- 管理者ページはクライアントサイドルート `/admin` です。Cognito の `redirect_uri` /
  `logout_uri` はこのページ自身の URL（origin + pathname）を使います。ローカルで
  Hosted UI を試す場合は、CDK 側で dev 用のコールバック URL（localhost）を許可して
  ください（デプロイ手順の `includeLocalhostCallback` を参照）。

> 注: 一部のサンドボックス環境では壊れた `NODE_OPTIONS` を回避するため、
> `npm` コマンドの前に `env -u NODE_OPTIONS` を付ける必要があります
> （例: `env -u NODE_OPTIONS npm install`）。通常の環境では不要です。

---

## 破棄 (Teardown)

不要になったら、以下で CDK スタックのリソース（Lambda / API / DynamoDB / Cognito）を削除できます。

```bash
npx cdk destroy
```

DynamoDB テーブルと Cognito User Pool は `RemovalPolicy.DESTROY` を設定しているため、
スタック削除時に一緒に削除されます。**Amplify Hosting は CDK 管理外**なので、Amplify
コンソールでアプリを削除してください。

---

## 検証コマンド (ネットワーク接続環境で実行)

本リポジトリはネットワーク非接続環境で作成されたため、下記が
**フル検証のためのコマンド**です。接続環境で実行してください。

```bash
# バックエンド（ルートの CDK プロジェクト）
env -u NODE_OPTIONS npm ci
env -u NODE_OPTIONS npm run build
env -u NODE_OPTIONS npm test
env -u NODE_OPTIONS npx cdk synth

# フロントエンド（React + Vite の SPA）
cd frontend
env -u NODE_OPTIONS npm install
env -u NODE_OPTIONS npm run build   # tsc 型チェック + Vite バンドル。frontend/dist を生成
```

> 注: 一部のサンドボックス環境では壊れた `NODE_OPTIONS` を回避するため、
> node/npm/npx コマンドの前に `env -u NODE_OPTIONS` を付ける必要があります。
> 通常の環境ではこの接頭辞は不要です。

---

## 利用コストを最低限にするための設計 (コスト最適化)

このアプリは「常時稼働しているように見えて、待機中は課金されない」ことを目指しています。
各サービスの選定理由は次のとおりです。

| 選択 | コスト面の理由 |
| --- | --- |
| **DynamoDB オンデマンド (PAY_PER_REQUEST)** | プロビジョニング済みキャパシティを持たないため、**アイドル時の固定料金がゼロ**。リクエスト単位の従量課金。 |
| **AWS Lambda (ARM64 / Graviton)** | 呼び出し回数と実行時間のみの課金で、**リクエストが無ければ料金は発生せずゼロにスケール**。ARM64 は x86 より単価が安い。メモリ 256 MB / タイムアウト 10 秒に抑制。 |
| **API Gateway HTTP API (v2)** | 同等の REST API より**リクエスト単価が安い**。 |
| **Amazon Cognito User Pool** | ユーザー数に応じた無料枠があり、**アイドル時の固定料金は発生しない**。JWT オーソライザーもリクエスト時のみ動作。 |
| **AWS Amplify Hosting** | フロント配信は Amplify に集約。課金は主に**ビルド時間と配信（ストレージ/転送）**のみ。Vite の npm ビルドは高速で、依存関係を最小限に抑えてビルド時間を短縮。以前の **S3 + CloudFront によるフロント配信は廃止**（冗長かつ 403/404 書き換えの問題があったため）。 |
| **VPC / NAT ゲートウェイ なし** | NAT ゲートウェイは**アイドルでも時間課金**が発生するため使用しない。 |
| **EC2 / RDS などの常時起動リソース なし** | 24 時間課金される計算・DB リソースを一切使わない。 |

要するに、**待機中（誰もアクセスしていない時間）の課金がほぼ発生しない**構成です。
料金が増えるのはアクセス（リクエスト）や Amplify のビルド/配信が発生したときだけです。

---

## テストについて

- `test/quiz-app-stack.test.ts` — `aws-cdk-lib/assertions` の `Template` を使い、
  スタックをメモリ内で合成して次を検証します: DynamoDB がオンデマンド課金であること、
  Lambda が ARM64 + Node ランタイムであること、HTTP API であること、4 つのルート
  （公開 3 + 管理者 1）が存在すること、管理者ルートが JWT オーソライザーで保護され公開ルートは
  未保護であること、Cognito User Pool（セルフサインアップ無効）とパブリックアプリクライアントが
  あること、**CloudFront / S3 のフロント配信リソースが存在しないこと**、そして **HTTP API の CORS が
  `authorization` ヘッダを許可していること**。
- `test/handler.test.ts` — Lambda ソースから **実際にエクスポートされている純粋関数**
  （`scoreAnswers` など）を import して検証します。実運用コードをそのまま呼ぶため、
  ロジックが壊れればテストは失敗します。

---

## 今後の拡張候補 (Optional follow-ups)

- **CORS を実ドメインに限定**: `allowOrigins` を Amplify ドメインに絞る。
- **カスタムドメイン**: Amplify のカスタムドメイン + Route 53 で独自ドメイン + HTTPS を構成する。
- **CI/CD**: GitHub Actions などで `npm test` と `cdk deploy` を自動化する（フロントは Amplify が自動ビルド）。
