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
- **管理者ページ（`/admin.html`）** から、自作のクイズを登録・編集（全置換）・削除
  （確認ダイアログ付き）できます。既存クイズの一覧も表示されます。管理者認証は
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
   │   ├── POST   /api/admin/quizzes            （管理者のみ / JWT オーソライザー）
   │   ├── GET    /api/admin/quizzes/{quizId}   （管理者のみ / JWT・正解 answerIndex を含む＝編集フォーム用）
   │   ├── PUT    /api/admin/quizzes/{quizId}   （管理者のみ / JWT・全置換で更新）
   │   └── DELETE /api/admin/quizzes/{quizId}   （管理者のみ / JWT・削除）
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
  - `allowMethods`: `GET` / `POST` / `PUT` / `DELETE` / `OPTIONS`（管理者の編集 `PUT`・削除 `DELETE`
    ルートに対応するため `PUT` / `DELETE` を追加）
  - `allowHeaders`: `content-type` と `authorization`（管理者 API が Authorization ヘッダを送るため）
  - `allowOrigins`: 既定で Amplify ドメイン `https://main.d2uwsqpk41y7so.amplifyapp.com` に限定しています
    （以前の `*` から変更）。デプロイごとに `allowedOrigin` の CDK コンテキストで上書きでき、
    たとえば `npx cdk deploy -c allowedOrigin=https://your-domain.example` のように指定します。
    さらに Lambda の応答ヘッダ `access-control-allow-origin` も同じオリジン（`ALLOWED_ORIGIN`
    環境変数）に設定されるため、プリフライトと実レスポンスの両方が一致し、CORS はエンドツーエンドで
    絞られます。CORS はブラウザ側の制御であり、管理者 API は別途 Cognito JWT オーソライザーで保護されます。
- **API**: API Gateway HTTP API (v2)。REST API より安価。ルートは `/api` プレフィックス配下です。
- **管理者認証**: Amazon Cognito User Pool + Hosted UI。パブリックなアプリクライアント（クライアント
  シークレットなし）を使い、`POST /api/admin/quizzes` を JWT オーソライザーで保護します。
  セルフサインアップは無効で、管理者ユーザーは運用者が CLI/コンソールで作成します（後述）。
- **管理者の編集・削除 API**: 登録済みクイズの編集・削除は次の 3 ルートで行います。いずれも既存の
  `POST /api/admin/quizzes` と**同じ Cognito JWT オーソライザー**で保護され、公開ルート
  （`GET /api/quizzes`・`GET /api/quizzes/{quizId}`・`POST /api/quizzes/{quizId}/submit`）は変更ありません。
  - `PUT /api/admin/quizzes/{quizId}`（**編集は全置換方式**）: 既存の `Q#n` 項目をすべて削除してから
    `META` と新しい `Q#n` を書き込みます（`questionCount` を正しく保つため）。`quizId` はパスから取得し
    **新規採番はしません**（ボディの `quizId` は無視）。指定した `quizId` が存在しない場合は **404** を返します。
    なお全置換は「削除 → 書き込み」の 2 段階で行われ、トランザクションではありません（低頻度・
    運用者のみの管理操作という前提での意図的なトレードオフです）。万一その間で失敗した場合は
    同じ `PUT` を再実行すれば復旧します。
  - `DELETE /api/admin/quizzes/{quizId}`（**削除**）: 対象の `META` と全 `Q#n` を削除します。存在しない
    場合は **404** を返します。
  - `GET /api/admin/quizzes/{quizId}`（**管理者用の読み取り**）: 公開用 `GET` と異なり、各問の正解
    `answerIndex` を**含めて**返します（編集フォームの正解プリフィル用）。存在しない場合は **404** を返します。
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

1. Amplify のドメインで `/admin.html` を開きます（例: `https://main.<appId>.amplifyapp.com/admin.html`）。
   これは Vite のマルチページビルドで生成される実体のある静的ファイルです（SPA 書き換えルールは不要）。
2. 「ログイン」ボタンを押すと Cognito Hosted UI にリダイレクトされ、管理者メールアドレスと
   パスワードでログインします（ユーザーは事前に運用者が作成、後述）。
3. ログイン後、管理者ページには**既存クイズの一覧**が表示されます。各クイズから
   「編集」「削除」が行え、「新規作成」でフォームを空にして新しいクイズを追加できます。
4. **新規作成**: タイトルと問題（各問 2〜4 個の選択肢、正解を 1 つ指定）を入力して送信します。
   送信は `POST /api/admin/quizzes` に `Authorization: Bearer <id_token>` 付きで行われ、
   JWT オーソライザーの検証を通過すると DynamoDB に保存されます。未認証・権限不足の場合は
   401/403 で拒否されます。
5. **編集（全置換）**: 一覧の「編集」を押すと、管理者用 API（正解込み）で現在の内容を
   読み込んでフォームに反映します。保存すると `PUT /api/admin/quizzes/{quizId}` で
   そのクイズの内容を**丸ごと置き換え**ます（差分更新ではなく全置換）。
6. **削除**: 一覧の「削除」を押すと**確認ダイアログ**が表示され、了承すると
   `DELETE /api/admin/quizzes/{quizId}` でそのクイズを削除します。いずれの書き込み
   操作も `Authorization: Bearer <id_token>` を付与し、未認証・権限不足なら 401/403 で
   拒否されます。
7. 登録・編集・削除の結果は、トップページ（`/` または `/index.html`）の一覧にも反映されます。

---

## クイズ履歴とグラフ（クライアント側・ログイン不要）

クイズに回答して採点結果が表示されると、その結果が**閲覧中のブラウザの localStorage**
（キー `quizHistory`）に自動保存されます。過去の履歴はトップページの「**履歴を見る**」
ボタン（クイズ一覧画面・結果画面のいずれからも到達可能）から確認できます。

- **ログイン不要・バックエンド変更なし**: 履歴の保存・読み込み・集計はすべてブラウザ内で
  完結します。サーバー（Lambda / DynamoDB / API）には一切送信しないため、**サーバー費用は
  発生しません**。
- **ブラウザ単位の保存**: 履歴はそのブラウザの localStorage に保存されるため、**別のブラウザや
  端末とは同期されません**。プライベートブラウズや localStorage 無効環境では保存されず、
  空の履歴として安全に振る舞います（例外は投げません）。
- **消去**: 履歴画面の「**履歴を消去**」ボタンから、確認ダイアログを経て全消去できます。
- **2 つの自前 SVG グラフ**: チャートライブラリや日付ライブラリを**追加せず**、React で
  インライン `<svg>` を直接描画しています。表示するのは次の 2 つです。
  - **スコア推移の折れ線グラフ**: 受験順（時系列）に正答率（0〜100%）の推移を表示。
  - **クイズ別の平均正答率の棒グラフ**: クイズごとの平均正答率（0〜100%）と受験回数を表示。
  グラフは `viewBox` によるレスポンシブ対応で、配色は既存の CSS 変数に委ねているため
  ライト / ダークの両モードで読めます。`role="img"` / `aria-label` / `<title>` と数値ラベルを
  備え、色だけに依存しません。
- **追加依存ゼロ**: フロントエンドの依存関係は `react` と `react-dom` のみで、この機能のために
  チャート / 日付 / ルーターなどのライブラリは追加していません。ネットワーク接続環境で
  `cd frontend && npm run build`（`tsc -b` + `vite build`）が通ることで検証します。

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
   フロントエンドは Vite のマルチページビルドで、公開アプリ（`/index.html`）と管理者
   ページ（`/admin.html`）の 2 つを**実体のある静的ファイル**として出力します。どちらも
   実ファイルなので、**SPA 用の書き換えルール（全パスを `/index.html` にリライト）は不要**です。
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
   > **補足**: React フロントエンドは Vite の**マルチページ**構成で、管理者ページは
   > 実体のある静的ファイル `/admin.html` として配信されます。そのため管理者ページ自身の
   > URL（origin + `/admin.html`）は、CDK が Cognito に登録済みのコールバック/ログアウト
   > URL と**完全一致**します。**CDK の変更も Amplify の SPA 書き換えルールも不要**です。

5. **（任意）CORS の許可オリジンを変更する。**
   CORS の `allowOrigins` は既定で Amplify ドメイン `https://main.d2uwsqpk41y7so.amplifyapp.com`
   に限定済みです。別のドメイン（独自ドメイン等）に変更したい場合のみ、`allowedOrigin` の CDK
   コンテキストで上書きして再デプロイします。
   ```bash
   npx cdk deploy -c allowedOrigin=https://your-domain.example
   ```
   この値は CORS プリフライトの `allowOrigins` と Lambda の `access-control-allow-origin`
   応答ヘッダ（`ALLOWED_ORIGIN` 環境変数）の両方に反映されます。

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
4. **SPA 書き換えルールは不要**です。フロントエンドは Vite の**マルチページ**ビルドで、
   公開アプリ（`/index.html`）と管理者ページ（`/admin.html`）の 2 つを実体のある静的
   ファイルとして出力します。どちらも実ファイルなので、Amplify コンソールで「全パスを
   `/index.html` にリライト」する SPA 用ルールを追加する必要はありません。
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

> **CORS について**: API の CORS `allowOrigins` は既定で Amplify ドメイン
> `https://main.d2uwsqpk41y7so.amplifyapp.com` に限定済みです（以前の `*` から変更）。別の
> ドメインに合わせる場合は `npx cdk deploy -c allowedOrigin=https://your-domain.example` の
> ように `allowedOrigin` コンテキストで上書きして再デプロイしてください。この値は Lambda の
> `access-control-allow-origin` 応答ヘッダ（`ALLOWED_ORIGIN` 環境変数）にも反映され、
> CORS はエンドツーエンドで絞られます。

---

## 利用開始と動作確認 (Verify)

- Amplify のドメイン（例: `https://main.<appId>.amplifyapp.com`）を開くとクイズアプリが表示されます。
- クイズを 1 つ選び、回答して採点結果が返ることを確認します（API へのクロスオリジン呼び出しが成功）。
- `/admin.html` を開き、Cognito Hosted UI でログイン → クイズを登録できることを確認します。
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
- フロントエンドは Vite の**マルチページ**構成です。公開アプリは `/`（`index.html`）、
  管理者ページは `/admin.html` という実体のある静的ファイルとして配信されます
  （クライアントサイドルーターは使いません。ページ間の遷移は通常の `<a>` リンク）。
- 管理者ページの Cognito `redirect_uri` / `logout_uri` はこのページ自身の URL
  （origin + pathname、すなわち `.../admin.html`）を使います。この URL は CDK が Cognito に
  登録済みのコールバック/ログアウト URL と一致するため、SPA 書き換えルールも CDK 変更も
  不要です。ローカルで Hosted UI を試す場合は、CDK 側で dev 用のコールバック URL
  （`http://localhost:8080/admin.html`）を許可してください（デプロイ手順の
  `includeLocalhostCallback` を参照）。なお Vite 開発サーバーの既定ポートは 5173 のため、
  localhost で Hosted UI を試す場合はポートの整合にも注意してください。

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
  Lambda が ARM64 + Node ランタイムであること、HTTP API であること、7 つのルート
  （公開 3 + 管理者 4: `POST` / `GET` / `PUT` / `DELETE`）が存在すること、管理者ルートが
  すべて JWT オーソライザーで保護され公開ルートは未保護であること、Cognito User Pool
  （セルフサインアップ無効）とパブリックアプリクライアントがあること、**CloudFront / S3 の
  フロント配信リソースが存在しないこと**、そして **HTTP API の CORS が `authorization` ヘッダを
  許可していること**。
- `test/handler.test.ts` — Lambda ソースから **実際にエクスポートされている純粋関数**
  （`scoreAnswers` など）を import して検証します。実運用コードをそのまま呼ぶため、
  ロジックが壊れればテストは失敗します。

---

## 今後の拡張候補 (Optional follow-ups)

- **カスタムドメイン**: Amplify のカスタムドメイン + Route 53 で独自ドメイン + HTTPS を構成する
  （その際は `allowedOrigin` コンテキストで CORS 許可オリジンを新ドメインに合わせて再デプロイ）。
- **CI/CD**: GitHub Actions などで `npm test` と `cdk deploy` を自動化する（フロントは Amplify が自動ビルド）。
