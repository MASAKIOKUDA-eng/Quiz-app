/**
 * Sample quiz seed data (Japanese).
 *
 * These are ORIGINAL questions that test AWS architecture design and
 * implementation reasoning (service selection trade-offs, cost, availability,
 * security, and serverless patterns). They are not copied from any AWS exam
 * material.
 *
 * `answerIndex` is the 0-based index of the correct option. It is stored in
 * DynamoDB but is STRIPPED from any question payload returned to the client
 * so answers cannot be inspected before submitting.
 */
export interface SeedQuestion {
  text: string;
  options: string[];
  answerIndex: number;
}

export interface SeedQuiz {
  quizId: string;
  title: string;
  questions: SeedQuestion[];
}

export const SAMPLE_QUIZZES: SeedQuiz[] = [
  {
    quizId: 'aws-architecture',
    title: 'AWS アーキテクチャ設計クイズ',
    questions: [
      {
        text: 'トラフィックが平常時はほぼゼロで、ときどき予測不能なスパイクが発生するアプリのテーブル設計として、コストと運用の観点で最も適しているのはどれですか？',
        options: [
          'DynamoDB をオンデマンド（従量課金）キャパシティモードで使う',
          'DynamoDB をプロビジョンドキャパシティで最大スパイクに合わせて固定する',
          'ピーク時に合わせて RDS を大きめのインスタンスで常時起動する',
          'EC2 上に自前のキー・バリューストアを常時起動する',
        ],
        answerIndex: 0,
      },
      {
        text: 'プライベートサブネットの Lambda から S3 にアクセスしたいが、アイドル課金を避けたい。コストを抑える構成はどれですか？',
        options: [
          'NAT Gateway を経由してインターネット越しに S3 へアクセスする',
          'S3 用のゲートウェイ型 VPC エンドポイントを使う',
          'すべての Lambda をパブリックサブネットに移動する',
          'S3 バケットを一時的にパブリック公開する',
        ],
        answerIndex: 1,
      },
      {
        text: '1 つのイベントを複数の独立したサブスクライバーへファンアウトして配信したい。最も適したサービスはどれですか？',
        options: [
          'SQS 標準キューを 1 本だけ使う',
          'SNS トピックに複数のサブスクライバーを登録する',
          'DynamoDB Streams を直接複数の宛先に接続する',
          'Kinesis Data Firehose を同期呼び出しで使う',
        ],
        answerIndex: 1,
      },
      {
        text: 'コスト重視でシンプルな REST エンドポイントを公開する場合、API Gateway の選択として一般に安価なのはどちらですか？',
        options: [
          'REST API（従来型）',
          'HTTP API',
          'WebSocket API',
          'どちらも料金は同じ',
        ],
        answerIndex: 1,
      },
      {
        text: '同じワークロードを x86 から切り替えるだけで、同等性能かつ低コストを狙える Lambda のアーキテクチャはどれですか？',
        options: [
          'x86_64 のまま同時実行数を増やす',
          'arm64（Graviton2）を選択する',
          'プロビジョンド同時実行を常時最大にする',
          'メモリを最小の 128MB に固定する',
        ],
        answerIndex: 1,
      },
      {
        text: '本番の RDS で単一 AZ 障害時にも自動フェイルオーバーで可用性を確保したい。適切な設定はどれですか？',
        options: [
          'マルチ AZ 配置を有効にする',
          'リードレプリカを 1 台だけ同一 AZ に置く',
          'スナップショットを毎時取得する',
          'インスタンスサイズを大きくする',
        ],
        answerIndex: 0,
      },
      {
        text: 'S3 に置いた静的サイトを CloudFront で配信しつつ、バケットは非公開のままにしたい。推奨される方式はどれですか？',
        options: [
          'バケットポリシーで全世界に GetObject を許可する',
          'CloudFront の OAC（Origin Access Control）を使いバケットは非公開にする',
          'S3 の静的ウェブサイトホスティングを直接公開する',
          'すべてのオブジェクトに署名付き URL を必須にする',
        ],
        answerIndex: 1,
      },
      {
        text: 'SQS からメッセージを受け取る Lambda が、再配信により同じメッセージを二重処理する可能性がある。整合性を保つ設計はどれですか？',
        options: [
          '処理を必ず 1 回だけ実行できると仮定してリトライを無効化する',
          '一意なメッセージ ID を使って冪等（idempotent）に処理する',
          'メッセージを受信したら即座に例外を投げて破棄する',
          '可視性タイムアウトを 0 秒に設定する',
        ],
        answerIndex: 1,
      },
      {
        text: 'Lambda から特定の 1 つの DynamoDB テーブルにのみ書き込ませたい。最小権限の IAM 設計はどれですか？',
        options: [
          'AdministratorAccess をロールに付与する',
          '対象テーブルの ARN に限定して必要な dynamodb アクションのみを許可する',
          'すべての DynamoDB テーブルに対して "dynamodb:*" を許可する',
          'アクセスキーを環境変数に直接埋め込む',
        ],
        answerIndex: 1,
      },
      {
        text: 'アクセスが断続的でスケールゼロによるコスト削減を重視したいリレーショナル DB のワークロードに適した選択はどれですか？',
        options: [
          '大きめの固定サイズでプロビジョンドした Aurora',
          'Aurora Serverless v2（需要に応じてスケール）',
          'EC2 上のセルフマネージド PostgreSQL を常時起動',
          'DynamoDB のプロビジョンドキャパシティ',
        ],
        answerIndex: 1,
      },
      {
        text: 'CloudFront で API レスポンスのキャッシュヒット率を上げたい。適切な考え方はどれですか？',
        options: [
          'すべてのクエリ文字列とヘッダーをキャッシュキーに含める',
          'キャッシュに必要な最小限のキー要素だけをキャッシュポリシーで指定する',
          'キャッシュを完全に無効化して常にオリジンへ転送する',
          'Cookie をすべてキャッシュキーに含める',
        ],
        answerIndex: 1,
      },
      {
        text: '大量の書き込みイベントを順序性を保ちながらニアリアルタイムで集約処理したい。最も適したサービスはどれですか？',
        options: [
          'SNS 標準トピック',
          'Kinesis Data Streams（シャード単位で順序保証）',
          'SQS 標準キュー',
          'S3 の PUT イベント通知のみ',
        ],
        answerIndex: 1,
      },
    ],
  },
  {
    quizId: 'aws-serverless',
    title: 'AWS サーバーレス設計クイズ',
    questions: [
      {
        text: 'サーバーレス API のコストを最小化する基本方針として最も適切なのはどれですか？',
        options: [
          '常時起動のサーバーを用意してアイドル時も課金される構成にする',
          'リクエストが来たときだけ課金される従量課金のマネージドサービスを組み合わせる',
          'すべてを 1 台の大きな EC2 に集約する',
          'プロビジョンド同時実行を常に最大値に固定する',
        ],
        answerIndex: 1,
      },
      {
        text: '同期的なユーザーリクエストに対し、重い後処理を切り離して応答を速くしたい。適した設計はどれですか？',
        options: [
          'リクエスト内で後処理を同期実行し、完了までレスポンスを待たせる',
          'キュー（SQS など）に投入して非同期に別 Lambda で処理する',
          '後処理をフロントエンドの JavaScript で実行する',
          '後処理を cron で 1 日 1 回まとめて実行する',
        ],
        answerIndex: 1,
      },
      {
        text: 'Lambda のコールドスタートによるレイテンシを、レイテンシ要件が厳しい経路で抑える手段はどれですか？',
        options: [
          'プロビジョンド同時実行（Provisioned Concurrency）を設定する',
          'タイムアウトを最大の 15 分に延ばす',
          'メモリを 128MB に固定する',
          'デプロイパッケージにできるだけ多くの依存を含める',
        ],
        answerIndex: 0,
      },
      {
        text: 'API Gateway HTTP API で保護されたルートに対し、Cognito ユーザープールのトークンで認可したい。適切な仕組みはどれですか？',
        options: [
          'API キーによる単純なレート制限のみ',
          'JWT オーソライザー（Cognito ユーザープール発行のトークンを検証）',
          'セキュリティグループでの IP 制限のみ',
          'Lambda 内でパスワードを平文比較する',
        ],
        answerIndex: 1,
      },
      {
        text: 'DynamoDB へまとまった件数を効率よく投入したい。適切な書き込み方法はどれですか？',
        options: [
          '1 件ずつ PutItem を直列に大量発行する',
          'BatchWriteItem で最大 25 件ずつまとめ、UnprocessedItems を再試行する',
          'Scan してから更新する',
          'テーブルを毎回作り直して流し込む',
        ],
        answerIndex: 1,
      },
      {
        text: 'クライアントに返す API レスポンスから、正解インデックスなどの機密フィールドを漏らさない設計はどれですか？',
        options: [
          '保存データをそのまま返し、フロントエンドで隠す',
          'サーバー側で公開用の射影（必要な項目のみ）を作ってから返す',
          'HTTPS を使えばどんな項目でも返してよい',
          'レスポンスを圧縮すれば機密は守られる',
        ],
        answerIndex: 1,
      },
    ],
  },
];
