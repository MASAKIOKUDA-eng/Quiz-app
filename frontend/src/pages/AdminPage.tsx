import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  createQuiz,
  getQuizzes,
  getAdminQuiz,
  updateQuiz,
  deleteQuiz,
  AuthError,
  type CreateQuizInput,
  type UpdateQuizInput,
  type AdminQuestionInput,
  type CreateQuizResponse,
  type QuizSummary,
} from '../api';
import {
  restoreToken,
  captureTokenFromHash,
  clearToken,
  loginUrl,
  logoutUrl,
} from '../auth';
import { COGNITO_DOMAIN, COGNITO_CLIENT_ID } from '../config';

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

// フォームのモード: 新規作成（POST）か既存クイズの編集（PUT・全置換）か。
type FormMode = { kind: 'create' } | { kind: 'edit'; quizId: string };

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

// 管理者クイズ管理フロー。旧 frontend/admin.js の挙動・検証・日本語文言を踏襲しつつ、
// 一覧・編集（全置換）・削除（確認ダイアログ付き）を追加する。
export default function AdminPage() {
  // 認証状態。トークンとその有効期限（ミリ秒エポック）。
  const [idToken, setIdToken] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number>(0);
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);

  // 一覧状態。
  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [listLoading, setListLoading] = useState<boolean>(false);
  const [listError, setListError] = useState<string>('');

  // フォーム状態。
  const [mode, setMode] = useState<FormMode>({ kind: 'create' });
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

  // 認証済みになったらクイズ一覧を読み込む。
  useEffect(() => {
    if (isAuthenticated) {
      void loadQuizzes();
    } else {
      setQuizzes([]);
      setListError('');
    }
    // loadQuizzes は毎回同じ振る舞いのため依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated]);

  // ---- 認証操作 ----------------------------------------------------------

  function handleLogin(): void {
    // Cognito 設定が未注入だと loginUrl() は不正な URL になるため、
    // リダイレクトせずにエラーメッセージを表示する（旧 admin.js の警告を踏襲）。
    if (!COGNITO_DOMAIN || !COGNITO_CLIENT_ID) {
      setStatus({
        message:
          'Cognito の設定（VITE_COGNITO_DOMAIN / VITE_COGNITO_CLIENT_ID）が未設定です。frontend/.env（Amplify の環境変数）を確認してください。',
        isError: true,
      });
      return;
    }
    window.location.assign(loginUrl());
  }

  function handleLogout(): void {
    clearToken();
    setIdToken(null);
    setExpiresAt(0);
    window.location.assign(logoutUrl());
  }

  // 401（AuthError）共通処理: トークンをクリアしてログイン画面に戻す。
  function handleAuthError(): void {
    clearToken();
    setIdToken(null);
    setExpiresAt(0);
    setStatus({
      message: 'ログインが必要です（認証エラー）',
      isError: true,
    });
  }

  // ---- 一覧 --------------------------------------------------------------

  async function loadQuizzes(): Promise<void> {
    setListLoading(true);
    setListError('');
    try {
      const res = await getQuizzes();
      setQuizzes(res.quizzes);
    } catch (err) {
      setListError(errorMessage(err));
    } finally {
      setListLoading(false);
    }
  }

  // ---- モード切り替え ----------------------------------------------------

  // フォームを新規作成モードの初期状態に戻す。
  function resetToCreate(): void {
    setMode({ kind: 'create' });
    setTitle('');
    setQuizId('');
    setQuestions([makeQuestion()]);
    setResult(null);
  }

  function handleNewQuiz(): void {
    resetToCreate();
    setStatus(EMPTY_STATUS);
  }

  // 編集モードへ: 管理者 GET（answerIndex 込み）でクイズを取得し、フォームへ流し込む。
  function enterEditMode(targetQuizId: string): void {
    if (!isAuthenticated || !idToken) {
      handleAuthError();
      return;
    }
    setResult(null);
    setStatus({ message: 'クイズを読み込み中...', isError: false });
    const token = idToken;
    void (async () => {
      try {
        const detail = await getAdminQuiz(targetQuizId, token);
        // サーバーの options はすべて空でないため、DOM 上のインデックスが
        // そのまま answerIndex に一致する（collectPayload の逆変換）。
        const rebuilt: QuestionState[] = detail.questions.map((q) => ({
          id: nextId(),
          text: q.text,
          options: q.options.map((optText, idx) => ({
            id: nextId(),
            text: optText,
            isCorrect: idx === q.answerIndex,
          })),
        }));
        setTitle(detail.title);
        setQuizId(detail.quizId);
        setQuestions(
          rebuilt.length > 0 ? rebuilt : [makeQuestion()],
        );
        setMode({ kind: 'edit', quizId: detail.quizId });
        setStatus(EMPTY_STATUS);
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthError();
          return;
        }
        setStatus({ message: errorMessage(err), isError: true });
      }
    })();
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

    const token = idToken;
    const currentMode = mode;

    if (currentMode.kind === 'edit') {
      setStatus({ message: '更新中...', isError: false });
      const updateInput: UpdateQuizInput = {
        title: payload.title,
        questions: payload.questions,
      };
      const editingQuizId = currentMode.quizId;
      void (async () => {
        try {
          const res = await updateQuiz(editingQuizId, updateInput, token);
          setStatus({
            message:
              'クイズを更新しました。（クイズ ID: ' +
              res.quizId +
              ' / 問題数: ' +
              (typeof res.questionCount === 'number'
                ? res.questionCount
                : '') +
              '）',
            isError: false,
          });
          await loadQuizzes();
        } catch (err) {
          if (err instanceof AuthError) {
            handleAuthError();
            return;
          }
          setStatus({ message: errorMessage(err), isError: true });
        }
      })();
      return;
    }

    setStatus({ message: '登録中...', isError: false });
    void (async () => {
      try {
        const res = await createQuiz(payload, token);
        setStatus(EMPTY_STATUS);
        setResult(res);
        await loadQuizzes();
      } catch (err) {
        if (err instanceof AuthError) {
          // 401: トークンをクリアしてログイン画面に戻す。
          handleAuthError();
          return;
        }
        setStatus({ message: errorMessage(err), isError: true });
      }
    })();
  }

  // ---- 削除 --------------------------------------------------------------

  function handleDelete(targetQuizId: string, targetTitle: string): void {
    if (!isAuthenticated || !idToken) {
      handleAuthError();
      return;
    }
    // 削除前に確認ダイアログを出す。
    const ok = window.confirm(
      '「' + targetTitle + '」を削除します。よろしいですか？',
    );
    if (!ok) {
      return;
    }
    setStatus({ message: '削除中...', isError: false });
    const token = idToken;
    void (async () => {
      try {
        await deleteQuiz(targetQuizId, token);
        // 編集中のクイズを削除した場合はフォームを新規作成モードに戻す。
        if (mode.kind === 'edit' && mode.quizId === targetQuizId) {
          resetToCreate();
        }
        setStatus({ message: 'クイズを削除しました。', isError: false });
        await loadQuizzes();
      } catch (err) {
        if (err instanceof AuthError) {
          handleAuthError();
          return;
        }
        setStatus({ message: errorMessage(err), isError: true });
      }
    })();
  }

  // フォームから { title, questions, quizId? } を組み立てる。
  // 検証エラーがある場合は例外を投げる（旧 admin.js の collectPayload を厳密にミラー）。
  // 新規作成・編集の両モードで同じ検証・answerIndex 換算を再利用する。編集モードでは
  // quizId はパスから決まるためボディに含めない（quizId 検証もスキップする）。
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

    // 編集モードでは quizId はパス（選択されたクイズ）で固定のため、
    // ボディの quizId 項目・検証は行わない。
    if (mode.kind === 'create') {
      const trimmedQuizId = quizId.trim();
      if (trimmedQuizId) {
        if (!/^[a-z0-9-]+$/.test(trimmedQuizId)) {
          throw new Error(
            'クイズ ID は半角英小文字・数字・ハイフンのみ使用できます。',
          );
        }
        payload.quizId = trimmedQuizId;
      }
    }

    return payload;
  }

  // ---- 描画 --------------------------------------------------------------

  const isEditing = mode.kind === 'edit';

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

          {/* 既存クイズの一覧 */}
          <section className="card admin-quiz-list-card">
            <div className="admin-quiz-list-header">
              <h2 className="admin-mode-heading">クイズ一覧</h2>
              <button
                type="button"
                className="btn primary small"
                onClick={handleNewQuiz}
              >
                新規作成
              </button>
            </div>

            {listLoading ? (
              <p className="status">クイズを読み込み中...</p>
            ) : listError ? (
              <p className="status error">{listError}</p>
            ) : quizzes.length === 0 ? (
              <p className="empty-state">クイズがありません</p>
            ) : (
              <ul className="admin-quiz-list">
                {quizzes.map((quiz) => (
                  <li className="admin-quiz-item" key={quiz.quizId}>
                    <span className="admin-quiz-title">{quiz.title}</span>
                    <span className="admin-quiz-count">
                      問題数: {quiz.questionCount}
                    </span>
                    <span className="admin-quiz-actions">
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => enterEditMode(quiz.quizId)}
                      >
                        編集
                      </button>
                      <button
                        type="button"
                        className="btn small"
                        onClick={() => handleDelete(quiz.quizId, quiz.title)}
                      >
                        削除
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

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
              <h2 className="admin-mode-heading">
                {isEditing ? 'クイズを編集' : 'クイズを新規作成'}
              </h2>

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

              {isEditing ? (
                <div className="admin-field">
                  <label htmlFor="quiz-id-readonly">クイズ ID</label>
                  <input
                    id="quiz-id-readonly"
                    type="text"
                    className="admin-input"
                    value={quizId}
                    readOnly
                  />
                </div>
              ) : (
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
              )}

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
                {isEditing ? (
                  <>
                    <button
                      type="button"
                      className="btn"
                      onClick={handleNewQuiz}
                    >
                      キャンセル
                    </button>
                    <button type="submit" className="btn primary">
                      更新する
                    </button>
                  </>
                ) : (
                  <button type="submit" className="btn primary">
                    登録する
                  </button>
                )}
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
