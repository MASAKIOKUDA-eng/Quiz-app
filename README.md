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
- **リアルタイム対戦（②）** に対応しています。ホストがルームを作成し、参加者は
  **ルームID** と表示名だけで（ログイン不要で）参加します。全員に同じ問題を同期配信し、
  参加者個人スコアのライブ順位表を表示します。ホスト（ルーム作成者）のみ既存の
  **Cognito 管理者ログイン**が必要です。通信は **API Gateway WebSocket API** で行い、
  採点はサーバー側で実施します（正解 `answerIndex` は参加者クライアントに一切送りません）。

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
- **バックエンド**: HTTP API 用の Lambda 関数（Node.js 22, ARM64）。VPC / NAT は使いません。
  リアルタイム対戦用には**専用の ws Lambda**（同じく Node.js 22 / ARM64・`lambda/ws.ts`）を
  追加しています（詳細は「リアルタイム対戦」節を参照）。
- **データストア**: DynamoDB シングルテーブル、オンデマンド課金。リアルタイム対戦の
  ルーム/接続/プレイヤー項目は同じテーブルに名前空間を分けて格納し、TTL 属性 `ttl` で
  自動失効させます（既存の `QUIZ#` 項目は不変）。

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

## スペシャル問題セット「JAWS SONIC 2026」

AWS コミュニティイベント向けのスペシャル問題として、**「JAWS SONIC 2026 スペシャル問題」**
（全 20 問・日本語）を同梱しています。内容は JAWS-UG（Japan AWS User Group）コミュニティの
一般知識と、AWS のアーキテクチャ設計・サーバーレス・コスト最適化に関する技術問題を
ミックスした構成です。各問は 4 択で、正解は 1 つだけです。

- **登録方法は「管理画面登録」です（シードではありません）**。この問題セットは
  デフォルト問題（`lambda/seed-data.ts`）には含めていません。運用者が**管理者ページから
  登録**して利用します。バックエンドの変更は不要です。
- 登録用のデータ一式は **[`docs/jaws-sonic-2026.json`](docs/jaws-sonic-2026.json)** に
  用意しています。この JSON は `POST /api/admin/quizzes` が受け付けるボディ形状
  （`title` / `questions[]` / 任意の `quizId`）に**そのまま適合**しており、`quizId` は
  `jaws-sonic-2026` を設定済みです。

### 登録手順（管理者ページ）

1. Amplify のドメインで `/admin.html` を開き、「ログイン」から Cognito Hosted UI で
   管理者としてログインします（管理者ユーザーの作成は「デプロイ後のセットアップ手順」を参照）。
2. 「新規作成」でフォームを開き、`docs/jaws-sonic-2026.json` を**内容の参照元**として
   タイトル・各問（4 択・正解 1 つ）を入力します。管理フォームは 1 問あたり 2〜4 個の
   選択肢に対応しており、本セットは全問 4 択です。
3. 送信すると `POST /api/admin/quizzes` に `Authorization: Bearer <id_token>` 付きで
   登録され、DynamoDB に保存されます。以後はトップページの一覧に表示され、他のクイズと
   同様に受験できます。

### （任意）Cognito トークンを使って直接登録する

`docs/jaws-sonic-2026.json` は API のリクエストボディと同一形状のため、Cognito の
ID トークンを持つ運用者は、フォームを使わずに直接 POST しても登録できます。
`<ApiEndpoint>` はデプロイ時の CfnOutput、`<idToken>` は管理者ログインで得た Cognito の
ID トークンです。

```bash
curl -i -X POST "<ApiEndpoint>/api/admin/quizzes" \
  -H "Authorization: Bearer <idToken>" \
  -H "Content-Type: application/json" \
  --data @docs/jaws-sonic-2026.json
```

> `quizId` は JSON に含まれる `jaws-sonic-2026`（`^[a-z0-9-]+$` に適合）がそのまま使われます。
> 未認証・権限不足の場合は 401/403 で拒否されます。

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

## リアルタイム対戦（②・ルームID方式）

複数人が同じ問題に同時に挑戦し、参加者個人スコアのライブ順位表を競う
**リアルタイム対戦モード**です。トップページ（`/index.html`）のクイズ一覧画面から
「**リアルタイム対戦**」ボタンで入り、ホスト（ルーム作成者）または参加者を選びます。
既存の個人プレイ（クイズ一覧・モード選択・回答・結果・履歴、一括／1 問ずつ）は
すべてそのまま利用でき、この機能は**それらに影響を与えない追加機能**です。

### 対戦の流れ

1. **ホストがルーム作成**: ホストは既存の**登録済みクイズから 1 つを選び**、ルームを
   作成します。出題は新規に作らず、通常プレイと同じクイズ（デフォルト問題・自作クイズ・
   JAWS SONIC 2026 など）を利用します。
2. **ルームID共有**: ルーム作成時に短い**ルームID**が発行されます。ホストはこれを
   参加者に口頭やチャットで共有します。
   ルームIDは紛らわしい文字（`0`/`O`/`1`/`I`/`L`）を除いた英数字 6 文字です。
3. **参加者が名前＋ルームIDで参加**: 参加者は**ログイン不要**で、**表示名**（1〜40 文字）と
   **ルームID**を入力して参加します。参加者名は順位表に表示されます。
4. **ホスト開始**: 参加者が揃ったらホストが「ゲーム開始」を押します。
5. **同じ問題を同期配信**: 全参加者に同じ問題が同時に配信されます。進行は**ホストが
   問題ごとに手動で進めます**（正解を表示 → 次の設問へ）。
6. **参加者個人スコアのライブ順位表**: 各参加者の回答はサーバー側で採点され、
   スコア降順（同点は名前昇順）の順位表がリアルタイムに全員へ配信されます。

### 出題と採点（サーバー側・正解は非公開）

- **出題は既存の登録済みクイズから選ぶ**だけで、対戦専用の問題管理はありません。
- **採点はサーバー側（ws Lambda）で行い**、DynamoDB に保存された正解 `answerIndex` を
  参照します。参加者/ブラウザに配信されるメッセージには**正解 `answerIndex` を一切
  含めません**（配信される問題は「番号・本文・選択肢」のみ）。個人プレイと同じく、
  クライアント側では答えが見えないようになっています。
- 参加者の回答は 1 問につき 1 回のみ有効（重複回答は無視）で、`in_question` フェーズの
  間だけ受け付けます。

### 認証モデル（ホストのみ Cognito / 参加者はログイン不要）

- **ホスト（ルーム作成者）**は、既存の **Amazon Cognito 管理者アカウント**で
  **Hosted UI** からログインする必要があります。ホスト用の画面は**公開アプリ**内にあり、
  ルーム作成・開始・進行・終了の各操作では毎回 Cognito の ID トークンをサーバーへ渡し、
  ws Lambda が発行元（issuer）・オーディエンス（アプリクライアント ID）・署名
  （プール JWKS による RS256 検証）を検証します。
- ホストのログインが公開アプリへ戻れるように、Cognito アプリクライアント
  （`AdminAppClient`）のコールバック/ログアウト URL に **ルート（`/`、末尾スラッシュ付き）**
  を登録しています（従来の `/admin.html` のエントリはそのまま残しています）。公開アプリは
  Amplify が**ルート URL**（`origin + '/'`）で配信するため、ログイン後にブラウザが着地するのは
  `/index.html` ではなく `/` です。Cognito は `redirect_uri` の**完全一致**を要求するので、
  フロントエンド（`frontend/src/auth.ts` の `publicRedirectUri()` = `origin + '/'`、
  `adminRedirectUri()` = `origin + '/admin.html'`）と CDK
  （`lib/quiz-app-stack.ts` の `callbackUrls` / `logoutUrls`）の文字列を
  **byte-for-byte で一致**させています。以前登録していた `/index.html` はブラウザの実際の
  `/` リダイレクトと一致せず `redirect_mismatch` の原因になっていたため削除しました。
  ローカル開発では `includeLocalhostCallback` が `true` の間 `http://localhost:8080/`
  と `http://localhost:8080/admin.html` も許可されます。
- **参加者**は**認証不要**です。表示名（1〜40 文字）とルームIDのみで参加します。
  参加者からのメッセージにトークンは含まれません。

### 切断時の挙動（ホストの再接続 / 参加者の退出）

- **ホストの一時切断は致命的ではありません**。ホストの `$disconnect` ではルームを
  `finished` にはせず、`hostConnId` を空にして「離席中」を示すだけで、ルームの進行状態
  （フェーズ・現在の設問・スコア）は保持されます。モバイル回線の切り替えや PC のスリープで
  一時的に切断されても、全員のゲームが終わってしまうことはありません。
- **ホストの再接続（`reattachRoom`）**: 再ログインしたホストは、トークンの `sub` が
  ルームの `hostSub` と一致する場合に限り、`reattachRoom` で既存ルームへ復帰できます。
  `hostConnId` を新しい接続に付け替え、進行状態を維持したまま操作を再開します。フロントの
  ホスト画面は、WebSocket が（再）接続できたときに保持しているルームIDへ自動で
  `reattachRoom` を送ります。ホストが戻らない場合でもルームは TTL で自動失効します。
- ブロードキャストされる `state` メッセージには **`hostConnected`（真偽値）** を含めます。
  ホスト離席中（`false`）は、参加者画面に「ホストが一時的に離席中です」と表示します。
- **参加者の切断では PLAYER# 行を削除します**（明示的な設計判断）。タブを閉じた参加者が
  ライブ順位表に「幽霊エントリ」として TTL（約 6 時間）まで残らないようにするためです。
  参加者は認証不要で再参加が安価なため、名前ごとの再接続復帰は用意していません。行の削除で
  同じ表示名の再利用も可能になります。

### アーキテクチャの追加点（WebSocket + ws Lambda + DynamoDB TTL）

既存の HTTP API 構成に対して、**追加**（additive）でリアルタイム対戦の基盤を足しています。
既存の HTTP API・その 7 ルート・JWT オーソライザー・個人プレイ・管理者機能・履歴・
シードは**一切変更していません**。

```
[ブラウザ / SPA（index.html）]
   │  WebSocket（wss://）
   ▼
[API Gateway WebSocket API (v2)]
   │   ├── $connect / $disconnect / $default
   │   └── createRoom / reattachRoom / joinRoom / startGame / submitAnswer / nextQuestion / endGame
   ▼
[AWS Lambda（ws.ts / Node.js 22, ARM64 / Graviton）]
   │   ホスト JWT 検証・サーバー採点・状態遷移・全員へブロードキャスト
   ▼
[Amazon DynamoDB（既存のシングルテーブルを再利用 / TTL 有効）]
```

- **API Gateway v2 WebSocket API**（新規）: 双方向のリアルタイム通信を担います。ルートは
  `$connect` / `$disconnect` / `$default` に加え、`createRoom` / `reattachRoom` / `joinRoom` /
  `startGame` / `submitAnswer` / `nextQuestion` / `endGame` の各アクション（JSON ボディの
  `action` フィールドでルーティング）。ステージ名は `prod`（自動デプロイ）です。
- **専用の ws Lambda**（新規・`lambda/ws.ts`）: ApiFunction と同じ構成（Node.js 22 /
  ARM64・メモリ 256 MB・タイムアウト 10 秒）です。サーバー権威（server-authoritative）の
  ゲーム状態機械（`lobby` → `in_question` → `between` → …→ `finished`）を実行し、
  API Gateway Management API（`PostToConnection`）で各接続へ状態を配信します。
- **DynamoDB は既存のシングルテーブルを再利用**: 対戦用の項目は名前空間を分けて格納します
  （`pk=ROOM#<roomId>` の `META` / `CONN#<connectionId>` / `PLAYER#<name>`、および
  `pk=CONN#<connectionId>` の逆引き）。既存の `QUIZ#` 項目には手を加えていません。
  各対戦用項目には数値の **TTL 属性 `ttl`**（epoch 秒・作成から約 6 時間後）を設定し、
  ルーム/接続/プレイヤーは**自動的に失効・削除**されます（クリーンアップのための常時
  稼働リソースは不要）。既存の `QUIZ#` 項目は `ttl` を持たないため失効しません。

### コスト面（アイドル時ほぼゼロ）

リアルタイム対戦の追加後も「**待機中は課金されない**」方針は変わりません。

- **DynamoDB オンデマンド（PAY_PER_REQUEST）**: 既存テーブルを再利用。固定料金なし。
- **API Gateway WebSocket API**: **接続時間と受信メッセージ**に対する従量課金で、接続が
  無ければ料金は発生しません。
- **ws Lambda（ARM64）**: 呼び出し回数と実行時間のみの課金でゼロにスケール。
- **VPC / NAT なし**: 時間課金される常時起動リソースは使いません。
- **TTL で自動掃除**: 期限切れのルーム/接続/プレイヤー項目は DynamoDB の TTL が無料で
  削除するため、掃除用の常駐処理は不要です。

要するに、**誰も対戦していない時間帯の追加コストはほぼゼロ**です。

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
   - `WebSocketEndpoint` — リアルタイム対戦の WebSocket エンドポイント（`wss://...` / `prod` ステージ）

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
   - `WS_URL` = `WebSocketEndpoint` → `VITE_WS_URL`（リアルタイム対戦の WebSocket 接続先）
     （例: `wss://xxxx.execute-api.<region>.amazonaws.com/prod`）
   これらの環境変数名は `amplify.yml` が参照する名前と一致している必要があります。
   フロントエンドは Vite のマルチページビルドで、公開アプリ（`/index.html`）と管理者
   ページ（`/admin.html`）の 2 つを**実体のある静的ファイル**として出力します。どちらも
   実ファイルなので、**SPA 用の書き換えルール（全パスを `/index.html` にリライト）は不要**です。
   デプロイ後、Amplify が払い出したドメイン（例: `https://main.<appId>.amplifyapp.com`）を控えます。

4. **Amplify ドメインが判明したら CDK スタックを再デプロイし、フロントエンドも再ビルド/再デプロイする。**
   ホストのログインが `redirect_mismatch` で失敗する問題を直すには、**両方**が必要です。
   片方だけでは `redirect_uri` が一致せず、失敗したままになります。

   **(1) バックエンド（Cognito のコールバック/ログアウト URL 更新）を再デプロイする。**
   `adminAppBaseUrl` パラメータに手順 3 の Amplify ドメインを**明示的に**渡します。渡さないと
   既定値（`http://localhost:8080`）に戻ってしまい、これがログイン失敗の一因でした。
   本番では `-c includeLocalhostCallback=false` も付けて、localhost へのリダイレクトを
   信頼しないようにします。
   ```bash
   npx cdk deploy \
     --parameters adminAppBaseUrl=https://main.d2uwsqpk41y7so.amplifyapp.com \
     -c includeLocalhostCallback=false
   ```
   `adminAppBaseUrl` には実際の Amplify ドメインを指定してください。これで
   `https://main.<appId>.amplifyapp.com/admin.html`（管理者ページ）と
   `https://main.<appId>.amplifyapp.com/`（公開アプリ = ホスト、**ルート**）が Hosted UI の
   `redirect_uri` / `logout_uri` として許可されます。ホストは `/index.html` ではなく
   サイトの**ルート**（`origin + '/'`）に戻ります。

   **(2) フロントエンドを再ビルドして Amplify に再デプロイする。**
   `frontend/src/auth.ts` の `publicRedirectUri()` / `adminRedirectUri()` が生成する
   `redirect_uri` は、上記 Cognito 登録値と byte-for-byte で一致する必要があるため、
   フロントエンドのビルドも更新します。
   ```bash
   cd frontend && npm install && npm run build
   ```
   ビルド後、Amplify で再デプロイします（Git 連携なら該当ブランチへの push で自動ビルド）。
   > **補足**: React フロントエンドは Vite の**マルチページ**構成で、管理者ページは
   > 実体のある静的ファイル `/admin.html` として、公開アプリは**ルート**（`/`）として配信されます。
   > 管理者ページの `redirect_uri`（`origin + '/admin.html'`）と、公開アプリ/ホストの
   > `redirect_uri`（`origin + '/'`）は、いずれも CDK が Cognito に登録した
   > コールバック/ログアウト URL と**完全一致**します。**Amplify の SPA 書き換えルールは不要**です。

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
- `WebSocketEndpoint` — リアルタイム対戦の WebSocket エンドポイント（`wss://...` / `prod` ステージ）。
  Amplify 環境変数 `WS_URL` に設定する（`amplify.yml` が `VITE_WS_URL` にマッピング）

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
   - `WS_URL` = `WebSocketEndpoint` → `VITE_WS_URL`（リアルタイム対戦の WebSocket 接続先）
     （例: `wss://xxxx.execute-api.<region>.amazonaws.com/prod`）
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
あわせて、リアルタイム対戦のホストが**公開アプリ（`/index.html`）**からログインできるよう、
`https://main.<appId>.amplifyapp.com/index.html` も同じアプリクライアントのコールバック/
ログアウト URL に**追加**されます（既存の `/admin.html` エントリはそのまま維持されます）。

> **リアルタイム対戦の `WS_URL` について**: CDK デプロイで得た `WebSocketEndpoint`
> （`wss://...` / `prod` ステージ）を Amplify 環境変数 `WS_URL` に設定してから、
> フロントエンドを**再デプロイ**してください（`amplify.yml` が `WS_URL` を `VITE_WS_URL` に
> マッピングしてビルドに注入します）。未設定の場合、対戦の WebSocket 接続だけが機能せず、
> 個人プレイや管理者機能には影響しません。

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
- **リアルタイム対戦**: クイズ一覧画面の「リアルタイム対戦」からホストとして Cognito
  ログイン → 登録済みクイズを選んでルーム作成 → 表示された**ルームID**を控えます。別の
  ブラウザ（またはシークレットウィンドウ）で参加者として**表示名＋ルームID**で参加し
  （ログイン不要）、ホストが開始・進行すると、両者に同じ問題が同期表示され、参加者名と
  スコアのライブ順位表が更新されることを確認します。`WS_URL`（`VITE_WS_URL`）が正しく
  設定されている必要があります。

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
# （リアルタイム対戦を試す場合は VITE_WS_URL に WebSocketEndpoint（wss://.../prod）も設定）

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
| **API Gateway WebSocket API (v2)** | リアルタイム対戦用。**接続時間と受信メッセージのみ**の従量課金で、接続が無ければ料金は発生しない。固定料金なし。 |
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
  許可していること**。リアルタイム対戦の追加分として、**WebSocket API（ProtocolType
  `WEBSOCKET`）**が存在すること、**2 つ目の Lambda（ws ハンドラ）が ARM64 であること**、
  その IAM ポリシーが `execute-api:ManageConnections` を許可していること、DynamoDB の
  **TTL が属性 `ttl` で有効**であること、**`WebSocketEndpoint` の CfnOutput** があることも
  検証します（既存の HTTP API の 7 ルート + 1 JWT オーソライザーは不変のまま）。
- `test/handler.test.ts` — Lambda ソースから **実際にエクスポートされている純粋関数**
  （`scoreAnswers` など）を import して検証します。実運用コードをそのまま呼ぶため、
  ロジックが壊れればテストは失敗します。リアルタイム対戦では `lambda/ws.ts` の純粋関数
  （ルームID生成、順位表の集計、ゲーム状態遷移、参加者向け問題への射影が `answerIndex` を
  含まないこと、回答採点、参加入力の検証）も同様に import して検証します。

---

## 今後の拡張候補 (Optional follow-ups)

- **カスタムドメイン**: Amplify のカスタムドメイン + Route 53 で独自ドメイン + HTTPS を構成する
  （その際は `allowedOrigin` コンテキストで CORS 許可オリジンを新ドメインに合わせて再デプロイ）。
- **CI/CD**: GitHub Actions などで `npm test` と `cdk deploy` を自動化する（フロントは Amplify が自動ビルド）。
