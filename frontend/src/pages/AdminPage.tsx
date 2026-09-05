import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createQuiz,
  AuthError,
  type CreateQuizInput,
  type AdminQuestionInput,
  type CreateQuizResponse,
} from '../api';
import {
  restoreToken,
  captureTokenFromHash,
  clearToken,
  loginUrl,
  logoutUrl,
} from '../auth';

// ---- フォームの状態モデル -----------------------------------------------

interface OptionRow {
  id: number;
  text: string;
  isCorrect: boolean;
}

interface QuestionState {
  id: number;
  text: string;
  options: OptionRow[];
}

interface Status {
  message: string;
  isError: boolean;
}

const EMPTY_STATUS: Status = { message: '', isError: false };

// 一意な行 ID を採番するためのカウンタ。
let seq = 0;
function nextId(): number {
  seq += 1;
  return seq;
}

function makeOption(): OptionRow {
  return { id: nextId(), text: '', isCorrect: false };
}

// 初期状態: 1 問、空の選択肢 2 行（旧 admin.js の初期状態をミラー）。
function makeQuestion(): QuestionState {
  return { id: nextId(), text: '', options: [makeOption(), makeOption()] };
}

// 管理者クイズ登録フロー。旧 frontend/admin.js の挙動・検証・日本語文言を踏襲する。
export default function AdminPage() {
  // 認証状態。トークンとその有効期限（ミリ秒エポック）。
  const [idToken, setIdToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);

  // フォーム状態。
  const [title, setTitle] = useState<string>('');
  const [quizId, setQuizId] = useState<string>('');
  const [questions, setQuestions] = useState<QuestionState[]>(() => [
    makeQuestion(),
  ]);
  const [result, setResult] = useState<CreateQuizResponse | null>(null);

  // マウント時: sessionStorage から復元 → URL ハッシュからトークンを捕捉。
  useEffect(() => {
    const restored = restoreToken();
    if (restored) {
      setIdToken(restored.idToken);
      setExpiresAt(restored.expiresAt);
    }
    const captured = captureTokenFromHash();
    if (captured.error) {
      setStatus({
        message: 'ログインに失敗しました: ' + captured.error,
        isError: true,
      });
    }
    if (captured.idToken && typeof captured.expiresAt === 'number') {
      setIdToken(captured.idToken);
      setExpiresAt(captured.expiresAt);
    }
  }, []);

  const isAuthenticated = useMemo(
    () => !!idToken && Date.now() < expiresAt,
    [idToken, expiresAt],
  );

  // ---- 認証操作 ----------------------------------------------------------

  function handleLogin(): void {
    window.location.assign(loginUrl());
  }

  function handleLogout(): void {
    clearToken();
    setIdToken(null);
    setExpiresAt(0);
    window.location.assign(logoutUrl());
  }

  // ---- 問題・選択肢の編集 ------------------------------------------------

  function addQuestion(): void {
    setQuestions((prev) => [...prev, makeQuestion()]);
  }

  function removeQuestion(qId: number): void {
    setQuestions((prev) => prev.filter((q) => q.id !== qId));
  }

  function setQuestionText(qId: number, text: string): void {
    setQuestions((prev) =>
      prev.map((q) => (q.id === qId ? { ...q, text } : q)),
    );
  }

  function addOption(qId: number): void {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId && q.options.length < 4
          ? { ...q, options: [...q.options, makeOption()] }
          : q,
      ),
    );
  }

  function removeOption(qId: number, oId: number): void {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId && q.options.length > 2
          ? { ...q, options: q.options.filter((o) => o.id !== oId) }
          : q,
      ),
    );
  }

  function setOptionText(qId: number, oId: number, text: string): void {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId
          ? {
              ...q,
              options: q.options.map((o) =>
                o.id === oId ? { ...o, text } : o,
              ),
            }
          : q,
      ),
    );
  }

  // 正解は 1 問につき 1 つ（ラジオ相当）。
  function setCorrect(qId: number, oId: number): void {
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === qId
          ? {
              ...q,
              options: q.options.map((o) => ({
                ...o,
                isCorrect: o.id === oId,
              })),
            }
          : q,
      ),
    );
  }

  // ---- 送信 --------------------------------------------------------------

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    setResult(null);

    let payload: CreateQuizInput;
    try {
      payload = collectPayload();
    } catch (err) {
      setStatus({ message: errorMessage(err), isError: true });
      return;
    }

    if (!isAuthenticated || !idToken) {
      setStatus({ message: 'ログインが必要です（認証エラー）', isError: true });
      setIdToken(null);
      setExpiresAt(0);
      return;
    }

    setStatus({ message: '登録中...', isError: false });
    const token = idToken;
    void (async () => {
      try {
        const res = await createQuiz(payload, token);
        setStatus(EMPTY_STATUS);
        setResult(res);
      } catch (err) {
        if (err instanceof AuthError) {
          // 401: トークンをクリアしてログイン画面に戻す。
          clearToken();
          setIdToken(null);
          setExpiresAt(0);
          setStatus({
            message: 'ログインが必要です（認証エラー）',
            isError: true,
          });
          return;
        }
        setStatus({ message: errorMessage(err), isError: true });
      }
    })();
  }

  // フォームから { title, questions, quizId? } を組み立てる。
  // 検証エラーがある場合は例外を投げる（旧 admin.js の collectPayload を厳密にミラー）。
  function collectPayload(): CreateQuizInput {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      throw new Error('タイトルを入力してください。');
    }

    if (questions.length === 0) {
      throw new Error('問題を 1 つ以上追加してください。');
    }

    const built: AdminQuestionInput[] = [];
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      const qNo = i + 1;
      const text = q.text.trim();
      if (!text) {
        throw new Error('問題 ' + qNo + ' の問題文を入力してください。');
      }

      // 空でない選択肢のみを収集する。
      const options: string[] = [];
      for (let j = 0; j < q.options.length; j++) {
        const val = q.options[j].text.trim();
        if (val) {
          options.push(val);
        }
      }
      if (options.length < 2) {
        throw new Error(
          '問題 ' + qNo + ' には空でない選択肢を 2 つ以上入力してください。',
        );
      }

      // 正解ラジオの DOM 上インデックス（先頭の isCorrect）。
      let checkedDomIndex = -1;
      for (let k = 0; k < q.options.length; k++) {
        if (q.options[k].isCorrect) {
          checkedDomIndex = k;
          break;
        }
      }
      if (checkedDomIndex === -1) {
        throw new Error('問題 ' + qNo + ' の正解を選択してください。');
      }

      // 空欄をスキップした options 配列に合わせて answerIndex を換算する。
      let answerIndex = -1;
      let counter = 0;
      for (let m = 0; m < q.options.length; m++) {
        if (q.options[m].text.trim()) {
          if (m === checkedDomIndex) {
            answerIndex = counter;
            break;
          }
          counter++;
        }
      }
      if (answerIndex === -1) {
        throw new Error(
          '問題 ' + qNo + ' の正解は空でない選択肢を選んでください。',
        );
      }

      built.push({ text, options, answerIndex });
    }

    const payload: CreateQuizInput = { title: trimmedTitle, questions: built };

    const trimmedQuizId = quizId.trim();
    if (trimmedQuizId) {
      if (!/^[a-z0-9-]+$/.test(trimmedQuizId)) {
        throw new Error(
          'クイズ ID は半角英小文字・数字・ハイフンのみ使用できます。',
        );
      }
      payload.quizId = trimmedQuizId;
    }

    return payload;
  }

  // ---- 描画 --------------------------------------------------------------

  return (
    <main className="app">
      <h1>クイズ管理者ページ</h1>
      <p className={status.isError ? 'status error' : 'status'}>
        {status.message}
      </p>

      {!isAuthenticated ? (
        <section className="card login-view">
          <p>クイズを登録するにはログインが必要です。</p>
          <button type="button" className="btn primary" onClick={handleLogin}>
            ログイン
          </button>
        </section>
      ) : (
        <section>
          <div className="admin-toolbar">
            <button type="button" className="btn" onClick={handleLogout}>
              ログアウト
            </button>
          </div>

          {result ? (
            <div className="card admin-result">
              <p className="admin-result-heading">クイズを登録しました。</p>
              <p>
                クイズ ID: {result.quizId} / 問題数:{' '}
                {typeof result.questionCount === 'number'
                  ? result.questionCount
                  : ''}
              </p>
              <a href="index.html">クイズアプリで確認する</a>
            </div>
          ) : (
            <form className="admin-form" onSubmit={handleSubmit}>
              <div className="admin-field">
                <label htmlFor="quiz-title-input">タイトル</label>
                <input
                  id="quiz-title-input"
                  type="text"
                  className="admin-input"
                  value={title}
                  autoComplete="off"
                  placeholder="例: AWS 基礎クイズ"
                  onChange={(e) => setTitle(e.target.value)}
                />
              </div>

              <div className="admin-field">
                <label htmlFor="quiz-id-input">
                  クイズ ID（任意 / 半角英数字とハイフン）
                </label>
                <input
                  id="quiz-id-input"
                  type="text"
                  className="admin-input"
                  value={quizId}
                  autoComplete="off"
                  placeholder="例: aws-basics"
                  onChange={(e) => setQuizId(e.target.value)}
                />
              </div>

              {questions.map((q, qIdx) => (
                <fieldset className="card admin-question" key={q.id}>
                  <legend className="admin-question-legend">
                    問題 {qIdx + 1}
                  </legend>

                  <div className="admin-field">
                    <label>問題文</label>
                    <input
                      type="text"
                      className="admin-input question-text"
                      value={q.text}
                      autoComplete="off"
                      placeholder="例: S3 の説明として正しいものは？"
                      onChange={(e) => setQuestionText(q.id, e.target.value)}
                    />
                  </div>

                  <div className="admin-options">
                    {q.options.map((o) => (
                      <div className="admin-option" key={o.id}>
                        <input
                          type="radio"
                          className="option-correct"
                          name={'correct-' + q.id}
                          title="正解にする"
                          checked={o.isCorrect}
                          onChange={() => setCorrect(q.id, o.id)}
                        />
                        <input
                          type="text"
                          className="admin-input option-text"
                          value={o.text}
                          autoComplete="off"
                          placeholder="選択肢"
                          onChange={(e) =>
                            setOptionText(q.id, o.id, e.target.value)
                          }
                        />
                        <button
                          type="button"
                          className="btn small"
                          disabled={q.options.length <= 2}
                          onClick={() => removeOption(q.id, o.id)}
                        >
                          削除
                        </button>
                      </div>
                    ))}
                  </div>

                  <div className="admin-question-controls">
                    <button
                      type="button"
                      className="btn small"
                      disabled={q.options.length >= 4}
                      onClick={() => addOption(q.id)}
                    >
                      選択肢を追加
                    </button>
                    <button
                      type="button"
                      className="btn small"
                      onClick={() => removeQuestion(q.id)}
                    >
                      この問題を削除
                    </button>
                  </div>
                </fieldset>
              ))}

              <div className="admin-actions">
                <button type="button" className="btn" onClick={addQuestion}>
                  問題を追加
                </button>
                <button type="submit" className="btn primary">
                  登録する
                </button>
              </div>
            </form>
          )}
        </section>
      )}

      <div className="home-link">
        <a href="index.html">クイズアプリに戻る</a>
      </div>
    </main>
  );
}

// ---- ユーティリティ ------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
