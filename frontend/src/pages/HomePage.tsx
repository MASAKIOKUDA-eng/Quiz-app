import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type CSSProperties,
} from 'react';
import {
  getQuizzes,
  getQuiz,
  submitAnswers,
  type QuizSummary,
  type QuizDetail,
  type SubmitResult,
} from '../api';
import { append, makeRecord } from '../history';
import HistoryView from './HistoryView';
import BattlePage from './BattlePage';

// 表示ビュー。旧 app.js の show('list'|'quiz'|'result') をミラーしつつ、履歴画面と
// 回答方式の選択画面（chooseMode）を追加。
type View =
  | 'list'
  | 'chooseMode'
  | 'quiz'
  | 'result'
  | 'history'
  | 'battle';

// 回答方式。'all' は従来の一括表示、'oneByOne' は一問一答。
// どちらのモードも同じ selected 状態・同じ採点/結果/履歴の経路を共有する。
type AnswerMode = 'all' | 'oneByOne';

interface Status {
  message: string;
  isError: boolean;
}

const EMPTY_STATUS: Status = { message: '', isError: false };

// クイズ回答フロー（公開）。旧 frontend/app.js の挙動と日本語文言を踏襲する。
export default function HomePage() {
  const [view, setView] = useState<View>('list');
  const [status, setStatus] = useState<Status>({
    message: 'クイズを読み込み中...',
    isError: false,
  });
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [currentQuiz, setCurrentQuiz] = useState<QuizDetail | null>(null);
  // 選択中の回答。設問の n をキーに、選択肢インデックスを保持する。
  const [selected, setSelected] = useState<Record<number, number>>({});
  const [result, setResult] = useState<SubmitResult | null>(null);
  // 回答方式。クイズ開始時に選択する（既定は従来どおり一括表示）。
  const [mode, setMode] = useState<AnswerMode>('all');

  // 初回マウントでクイズ一覧を読み込む。
  useEffect(() => {
    void loadQuizzes();
  }, []);

  async function loadQuizzes(): Promise<void> {
    setStatus({ message: 'クイズを読み込み中...', isError: false });
    try {
      const data = await getQuizzes();
      setQuizzes(data.quizzes || []);
      setStatus(EMPTY_STATUS);
      setView('list');
    } catch (err) {
      setStatus({ message: errorMessage(err), isError: true });
    }
  }

  async function loadQuiz(quizId: string): Promise<void> {
    setStatus({ message: '問題を読み込み中...', isError: false });
    try {
      const quiz = await getQuiz(quizId);
      setCurrentQuiz(quiz);
      setSelected({});
      setResult(null);
      setStatus(EMPTY_STATUS);
      // フェッチは単一の入口のまま。成功後は回答方式の選択画面へ遷移する。
      setView('chooseMode');
    } catch (err) {
      setStatus({ message: errorMessage(err), isError: true });
    }
  }

  // 回答方式を確定してクイズ回答画面へ進む。selected は loadQuiz で既にリセット済み。
  function startQuiz(chosen: AnswerMode): void {
    setMode(chosen);
    setView('quiz');
  }

  function selectOption(questionN: number, optionIndex: number): void {
    setSelected((prev) => ({ ...prev, [questionN]: optionIndex }));
  }

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    const quiz = currentQuiz;
    if (!quiz) {
      return;
    }
    // 旧 app.js と同じく、未回答は -1。answers は number[]。
    const answers: number[] = quiz.questions.map((q) =>
      q.n in selected ? selected[q.n] : -1,
    );

    setStatus({ message: '採点中...', isError: false });
    void (async () => {
      try {
        const res = await submitAnswers(quiz.quizId, answers);
        setResult(res);
        // 採点成功時に履歴を 1 回だけ記録する。render / useEffect ではなく、この
        // 非同期コールバック内で行うことで、React.StrictMode の二重実行や再レンダーで
        // 重複記録されるのを防ぐ。
        append(
          makeRecord({
            quizId: quiz.quizId,
            title: quiz.title,
            score: res.score,
            total: res.total,
          }),
        );
        setStatus(EMPTY_STATUS);
        setView('result');
      } catch (err) {
        setStatus({ message: errorMessage(err), isError: true });
      }
    })();
  }

  return (
    <main className="app">
      <h1>クイズアプリ</h1>
      <p className={status.isError ? 'status error' : 'status'}>
        {status.message}
      </p>

      {view === 'list' && (
        <QuizList
          quizzes={quizzes}
          onSelect={loadQuiz}
          onViewHistory={() => setView('history')}
          onStartBattle={() => setView('battle')}
        />
      )}

      {view === 'chooseMode' && currentQuiz && (
        <ModeChooser
          quiz={currentQuiz}
          onChoose={startQuiz}
          onBack={() => setView('list')}
        />
      )}

      {view === 'quiz' &&
        currentQuiz &&
        (mode === 'oneByOne' ? (
          <QuizTakingOneByOne
            quiz={currentQuiz}
            selected={selected}
            onSelect={selectOption}
            onSubmit={handleSubmit}
            onBack={() => setView('list')}
          />
        ) : (
          <QuizTaking
            quiz={currentQuiz}
            selected={selected}
            onSelect={selectOption}
            onSubmit={handleSubmit}
            onBack={() => setView('list')}
          />
        ))}

      {view === 'result' && result && (
        <QuizResult
          result={result}
          quiz={currentQuiz}
          onRestart={loadQuizzes}
          onViewHistory={() => setView('history')}
        />
      )}

      {view === 'history' && <HistoryView onBack={() => setView('list')} />}

      {view === 'battle' && <BattlePage onBack={() => setView('list')} />}

      <div className="home-link">
        <a href="admin.html">管理者ページへ</a>
      </div>
    </main>
  );
}

// ---- クイズ一覧（カード） ------------------------------------------------

function QuizList({
  quizzes,
  onSelect,
  onViewHistory,
  onStartBattle,
}: {
  quizzes: QuizSummary[];
  onSelect: (quizId: string) => void;
  onViewHistory: () => void;
  onStartBattle: () => void;
}) {
  if (quizzes.length === 0) {
    return (
      <>
        <p className="empty-state">
          まだクイズがありません。管理者ページから作成できます。
        </p>
        <div className="quiz-actions">
          <button type="button" className="btn" onClick={onViewHistory}>
            履歴を見る
          </button>
          <button type="button" className="btn" onClick={onStartBattle}>
            リアルタイム対戦
          </button>
        </div>
      </>
    );
  }
  return (
    <>
      <ul className="quiz-list">
        {quizzes.map((quiz) => (
          <li key={quiz.quizId}>
            <button
              type="button"
              className="card quiz-card"
              onClick={() => onSelect(quiz.quizId)}
            >
              <span className="quiz-card-title">{quiz.title}</span>
              <span className="quiz-card-count">
                （全{quiz.questionCount}問）
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div className="quiz-actions">
        <button type="button" className="btn" onClick={onViewHistory}>
          履歴を見る
        </button>
        <button type="button" className="btn primary" onClick={onStartBattle}>
          リアルタイム対戦
        </button>
      </div>
    </>
  );
}

// ---- クイズ回答画面（進捗インジケータ付き） ------------------------------

function QuizTaking({
  quiz,
  selected,
  onSelect,
  onSubmit,
  onBack,
}: {
  quiz: QuizDetail;
  selected: Record<number, number>;
  onSelect: (questionN: number, optionIndex: number) => void;
  onSubmit: (event: React.FormEvent) => void;
  onBack: () => void;
}) {
  const total = quiz.questions.length;
  const answered = quiz.questions.filter((q) => q.n in selected).length;
  const percent = total > 0 ? Math.round((answered / total) * 100) : 0;

  return (
    <section>
      <h2 className="quiz-heading">{quiz.title}</h2>

      <div className="progress" aria-label="回答の進捗">
        <div className="progress-label">
          回答済み {answered} / {total}
        </div>
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: percent + '%' }} />
        </div>
      </div>

      <form onSubmit={onSubmit}>
        {quiz.questions.map((q) => (
          <fieldset className="card question" key={q.n}>
            <legend>
              Q{q.n + 1}. {q.text}
            </legend>
            {q.options.map((option, optIdx) => (
              <label className="option" key={optIdx}>
                <input
                  type="radio"
                  name={'q' + q.n}
                  value={String(optIdx)}
                  checked={selected[q.n] === optIdx}
                  onChange={() => onSelect(q.n, optIdx)}
                />
                <span> {option}</span>
              </label>
            ))}
          </fieldset>
        ))}

        <div className="quiz-actions">
          <button type="button" className="btn" onClick={onBack}>
            一覧に戻る
          </button>
          <button type="submit" className="btn primary">
            回答する
          </button>
        </div>
      </form>
    </section>
  );
}

// ---- 回答方式の選択画面 --------------------------------------------------

function ModeChooser({
  quiz,
  onChoose,
  onBack,
}: {
  quiz: QuizDetail;
  onChoose: (mode: AnswerMode) => void;
  onBack: () => void;
}) {
  return (
    <section className="mode-chooser">
      <h2 className="quiz-heading">{quiz.title}</h2>
      <p className="mode-chooser-label">回答方式を選んでください</p>

      <div className="mode-options">
        <button
          type="button"
          className="card mode-option"
          onClick={() => onChoose('all')}
        >
          <span className="mode-option-title">一括表示</span>
          <span className="mode-option-desc">
            すべての設問を 1 画面にまとめて表示します。
          </span>
        </button>
        <button
          type="button"
          className="card mode-option"
          onClick={() => onChoose('oneByOne')}
        >
          <span className="mode-option-title">一問一答</span>
          <span className="mode-option-desc">
            1 問ずつ順番に表示します。前へ / 次へで移動できます。
          </span>
        </button>
      </div>

      <div className="quiz-actions">
        <button type="button" className="btn" onClick={onBack}>
          一覧に戻る
        </button>
      </div>
    </section>
  );
}

// ---- クイズ回答画面（一問一答） ------------------------------------------

function QuizTakingOneByOne({
  quiz,
  selected,
  onSelect,
  onSubmit,
  onBack,
}: {
  quiz: QuizDetail;
  selected: Record<number, number>;
  onSelect: (questionN: number, optionIndex: number) => void;
  onSubmit: (event: React.FormEvent) => void;
  onBack: () => void;
}) {
  const total = quiz.questions.length;
  // 表示中の設問（0 始まりのインデックス）。
  const [current, setCurrent] = useState(0);
  const legendRef = useRef<HTMLLegendElement | null>(null);
  // 初回マウントで不用意にフォーカスを奪わないためのガード。
  const mountedRef = useRef(false);

  // 設問を移動したら新しい設問の見出しへフォーカスを移す（初期マウントは除く）。
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    legendRef.current?.focus();
  }, [current]);

  const q = quiz.questions[current];
  const answered = quiz.questions.filter((qq) => qq.n in selected).length;
  const percent = total > 0 ? Math.round((answered / total) * 100) : 0;
  const isLast = current === total - 1;

  return (
    <section className="one-by-one">
      <h2 className="quiz-heading">{quiz.title}</h2>

      <div className="progress" aria-label={'Q ' + (current + 1) + ' / ' + total}>
        <div className="progress-label">
          Q {current + 1} / {total}（回答済み {answered} / {total}）
        </div>
        <div className="progress-bar">
          <div
            className="progress-bar-fill"
            style={{ width: percent + '%' }}
          />
        </div>
      </div>

      <form onSubmit={onSubmit}>
        <fieldset className="card question" key={q.n}>
          <legend tabIndex={-1} ref={legendRef}>
            Q{q.n + 1}. {q.text}
          </legend>
          {q.options.map((option, optIdx) => (
            <label className="option" key={optIdx}>
              <input
                type="radio"
                name={'q' + q.n}
                value={String(optIdx)}
                checked={selected[q.n] === optIdx}
                onChange={() => onSelect(q.n, optIdx)}
              />
              <span> {option}</span>
            </label>
          ))}
        </fieldset>

        <div className="quiz-actions">
          <button type="button" className="btn" onClick={onBack}>
            一覧に戻る
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setCurrent((c) => Math.max(0, c - 1))}
            disabled={current === 0}
          >
            前へ
          </button>
          {isLast ? (
            <button type="submit" className="btn primary">
              回答する
            </button>
          ) : (
            <button
              type="button"
              className="btn primary"
              onClick={() => setCurrent((c) => Math.min(total - 1, c + 1))}
            >
              次へ
            </button>
          )}
        </div>
      </form>
    </section>
  );
}

// ---- 結果画面（スコアリング + 設問ごとのフィードバック） ------------------

function QuizResult({
  result,
  quiz,
  onRestart,
  onViewHistory,
}: {
  result: SubmitResult;
  quiz: QuizDetail | null;
  onRestart: () => void;
  onViewHistory: () => void;
}) {
  const percent =
    result.total > 0 ? Math.round((result.score / result.total) * 100) : 0;

  // 設問 n -> 選択肢配列。誤答時に正解の選択肢テキストを表示するために使う。
  const optionsByN = useMemo(() => {
    const map: Record<number, string[]> = {};
    if (quiz) {
      for (const q of quiz.questions) {
        map[q.n] = q.options;
      }
    }
    return map;
  }, [quiz]);

  return (
    <section className="result">
      <div
        className="score-ring"
        style={{ '--percent': percent } as CSSProperties}
        role="img"
        aria-label={'正解率 ' + percent + ' パーセント'}
      >
        <div className="score-ring-inner">
          <span className="score-ring-percent">{percent}%</span>
          <span className="score-ring-fraction">
            {result.score} / {result.total}
          </span>
        </div>
      </div>

      <p className="score">
        正解数: {result.score} / {result.total}
      </p>

      <p className="result-message">{encouragement(percent)}</p>

      <ul className="result-detail">
        {(result.results || []).map((r) => {
          const options = optionsByN[r.n];
          const correctText =
            options && r.answerIndex >= 0 && r.answerIndex < options.length
              ? options[r.answerIndex]
              : null;
          return (
            <li
              key={r.n}
              className={r.correct ? 'result-item correct' : 'result-item incorrect'}
            >
              <span className="result-item-label">
                Q{r.n + 1}: {r.correct ? '正解' : '不正解'}
              </span>
              {!r.correct && correctText !== null && (
                <span className="result-item-answer">
                  正解: {correctText}
                </span>
              )}
            </li>
          );
        })}
      </ul>

      <div className="quiz-actions">
        <button type="button" className="btn primary" onClick={onRestart}>
          もう一度クイズを選ぶ
        </button>
        <button type="button" className="btn" onClick={onViewHistory}>
          履歴を見る
        </button>
      </div>
    </section>
  );
}

// ---- ユーティリティ ------------------------------------------------------

// 正解率に応じた励ましメッセージ（表示のみ。採点・スコアには一切影響しない）。
function encouragement(percent: number): string {
  if (percent === 100) {
    return '満点です。お見事！';
  }
  if (percent >= 80) {
    return 'すばらしい成績です。';
  }
  if (percent >= 50) {
    return 'あと少し。もう一度挑戦してみましょう。';
  }
  return '復習して再チャレンジしてみましょう。';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
