/**
 * Sample quiz seed data (Japanese).
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
    quizId: 'general',
    title: '一般常識クイズ',
    questions: [
      {
        text: '日本の首都はどこですか？',
        options: ['大阪', '東京', '京都', '札幌'],
        answerIndex: 1,
      },
      {
        text: '富士山の標高に最も近いのはどれですか？',
        options: ['3,776m', '2,500m', '4,200m', '1,980m'],
        answerIndex: 0,
      },
      {
        text: '1年は何日ですか（平年）？',
        options: ['360日', '365日', '366日', '355日'],
        answerIndex: 1,
      },
    ],
  },
  {
    quizId: 'aws',
    title: 'AWS 基礎クイズ',
    questions: [
      {
        text: 'オブジェクトストレージのサービスはどれですか？',
        options: ['Amazon EC2', 'Amazon S3', 'Amazon RDS', 'Amazon VPC'],
        answerIndex: 1,
      },
      {
        text: 'サーバーレスでコードを実行するサービスはどれですか？',
        options: ['AWS Lambda', 'Amazon EBS', 'Amazon Route 53', 'AWS IAM'],
        answerIndex: 0,
      },
      {
        text: 'フルマネージドな NoSQL データベースはどれですか？',
        options: ['Amazon Aurora', 'Amazon DynamoDB', 'Amazon Redshift', 'Amazon EMR'],
        answerIndex: 1,
      },
    ],
  },
];
