import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { getQuizzes, type QuizSummary } from '../api';
import {
  captureTokenFromHash,
  clearToken,
  loginUrl,
  logoutUrl,
  restoreToken,
} from '../auth';
import {
  BattleSocket,
  type ConnectionStatus,
  type InboundMessage,
  type ParticipantQuestion,
  type ScoreboardEntry,
  type BattlePhase,
} from '../ws';

// リアルタイム対戦（②）。公開アプリ（index.html）内の 1 ビューとして動作する。
// ルーター無しの内部ステートマシンで「役割選択 -> ホストロビー / 参加者参加 ->
// ライブ対戦 -> 終了」を切り替える。ホストは既存の Cognito Hosted UI（auth.ts）で
// ログインし、参加者はログイン不要（表示名 + ルーム ID のみ）。
//
// 出題対象は既存の登録済みクイズから選ぶ（api.getQuizzes を再利用）。採点は
// サーバー側で行われ、参加者は answerIndex を一切受け取らない。

// 内部ビュー（役割選択が起点）。
type BattleView = 'chooseRole' | 'host' | 'participant';

interface Status {
  message: string;
  isError: boolean;
}

const EMPTY_STATUS: Status = { message: '', isError: false };

/**
 * サーバーからブロードキャストされる最新のゲーム状態（state メッセージの内容）。
 * ホスト / 参加者の双方でライブ設問・順位表の描画に使う。
 */
interface LiveState {
  phase: BattlePhase;
  currentQuestion: number;
  questionCount: number;
  quizTitle: string;
  question: ParticipantQuestion | null;
  scoreboard: ScoreboardEntry[];
  hostConnected: boolean;
}

export default function BattlePage({ onBack }: { onBack: () => void }) {
  const [view, setView] = useState<BattleView>('chooseRole');

  return (
    <section className="battle">
      <h2 className="quiz-heading">リアルタイム対戦</h2>

      {view === 'chooseRole' && (
        <RoleChooser
          onHost={() => setView('host')}
          onParticipant={() => setView('participant')}
          onBack={onBack}
        />
      )}

      {view === 'host' && (
        <HostBattle onBack={() => setView('chooseRole')} />
      )}

      {view === 'participant' && (
        <ParticipantBattle onBack={() => setView('chooseRole')} />
      )}
    </section>
  );
}

// ---- 役割選択 --------------------------------------------------------------

function RoleChooser({
  onHost,
  onParticipant,
  onBack,
}: {
  onHost: () => void;
  onParticipant: () => void;
  onBack: () => void;
}) {
  return (
    <div className="battle-roles">
      <p className="battle-lead">
        ホストがルームを作成して開始し、参加者は表示名とルーム ID で参加します。
      </p>
      <div className="mode-options">
        <button type="button" className="card mode-option" onClick={onHost}>
          <span className="mode-option-title">ホストになる</span>
          <span className="mode-option-desc">
            管理者ログインが必要です。登録済みクイズからルームを作成します。
          </span>
        </button>
        <button
          type="button"
          className="card mode-option"
          onClick={onParticipant}
        >
          <span className="mode-option-title">参加する</span>
          <span className="mode-option-desc">
            ログイン不要。表示名とルーム ID を入力して参加します。
          </span>
        </button>
      </div>
      <div className="quiz-actions">
        <button type="button" className="btn" onClick={onBack}>
          クイズ一覧に戻る
        </button>
      </div>
    </div>
  );
}

// ---- 接続ステータスの表示 --------------------------------------------------

function ConnectionBadge({ status }: { status: ConnectionStatus }) {
  const label: Record<ConnectionStatus, string> = {
    connecting: '接続中...',
    open: '接続済み',
    closed: '切断されました',
    error: '接続エラー',
  };
  return (
    <div className={'battle-conn battle-conn-' + status} aria-live="polite">
      <span className="battle-conn-dot" aria-hidden="true" />
      <span className="battle-conn-label">{label[status]}</span>
    </div>
  );
}

// ---- ライブ設問カード（ホスト / 参加者で共有） -----------------------------

function LiveQuestion({
  live,
  selectedIndex,
  answered,
  onSelect,
  onSubmit,
  interactive,
}: {
  live: LiveState;
  selectedIndex: number | null;
  answered: boolean;
  onSelect: (index: number) => void;
  onSubmit: () => void;
  // interactive=true のとき選択・回答できる（参加者のみ）。
  interactive: boolean;
}) {
  const q = live.question;
  const total = live.questionCount;

  return (
    <div className="battle-live">
      <div className="progress" aria-label="対戦の進捗">
        <div className="progress-label">
          {live.quizTitle}（Q {Math.min(live.currentQuestion + 1, total)} /{' '}
          {total}）
        </div>
        <div className="progress-bar">
          <div
            className="progress-bar-fill"
            style={{
              width:
                (total > 0
                  ? Math.round(((live.currentQuestion + 1) / total) * 100)
                  : 0) + '%',
            }}
          />
        </div>
      </div>

      {live.phase === 'in_question' && q && (
        <div className="card question battle-question">
          <p className="battle-question-text">
            Q{q.n + 1}. {q.text}
          </p>
          <div className="battle-options">
            {q.options.map((option, optIdx) => (
              <label
                className="option"
                key={optIdx}
                aria-disabled={!interactive || answered}
              >
                <input
                  type="radio"
                  name="battle-answer"
                  value={String(optIdx)}
                  checked={selectedIndex === optIdx}
                  disabled={!interactive || answered}
                  onChange={() => onSelect(optIdx)}
                />
                <span> {option}</span>
              </label>
            ))}
          </div>
          {interactive && (
            <div className="quiz-actions">
              <button
                type="button"
                className="btn primary"
                disabled={selectedIndex === null || answered}
                onClick={onSubmit}
              >
                {answered ? '回答済み' : 'この選択肢で回答する'}
              </button>
            </div>
          )}
        </div>
      )}

      {live.phase === 'between' && (
        <p className="battle-phase-note">
          正解発表中です。次の設問をお待ちください。
        </p>
      )}

      {live.phase === 'lobby' && (
        <p className="battle-phase-note">
          ホストの開始を待っています。
        </p>
      )}
    </div>
  );
}

// ---- ライブ順位表（ホスト / 参加者で共有） ---------------------------------

function Scoreboard({
  scoreboard,
  highlightName,
}: {
  scoreboard: ScoreboardEntry[];
  highlightName?: string;
}) {
  if (scoreboard.length === 0) {
    return (
      <p className="battle-scoreboard-empty">
        まだ参加者がいません。
      </p>
    );
  }
  return (
    <div className="battle-scoreboard">
      <h3 className="battle-scoreboard-title">ライブ順位表</h3>
      <ol className="battle-ranking">
        {scoreboard.map((entry, idx) => (
          <li
            key={entry.name}
            className={
              'battle-ranking-item' +
              (entry.name === highlightName ? ' battle-ranking-me' : '')
            }
          >
            <span className="battle-rank">{idx + 1}</span>
            <span className="battle-rank-name">{entry.name}</span>
            <span className="battle-rank-score">{entry.score}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ---- ホスト --------------------------------------------------------------

function HostBattle({ onBack }: { onBack: () => void }) {
  // 認証。auth.ts の Hosted UI（implicit grant）をそのまま再利用する。
  const [idToken, setIdToken] = useState<string | null>(null);
  const [authChecked, setAuthChecked] = useState(false);

  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('connecting');

  const [quizzes, setQuizzes] = useState<QuizSummary[]>([]);
  const [selectedQuizId, setSelectedQuizId] = useState<string>('');
  const [roomId, setRoomId] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);

  const socketRef = useRef<BattleSocket | null>(null);
  // onOpen（再接続時）から最新値を参照するための ref。既存ルームがあれば
  // reattachRoom で自動復帰する（ホストの一時切断を致命的にしない）。
  const roomIdRef = useRef<string | null>(null);
  const idTokenRef = useRef<string | null>(null);
  roomIdRef.current = roomId;
  idTokenRef.current = idToken;

  // マウント時にトークンを復元 / ハッシュから取得する（ページ非依存の auth.ts）。
  useEffect(() => {
    const captured = captureTokenFromHash();
    if (captured.error) {
      setStatus({
        message: 'ログインに失敗しました（' + captured.error + '）。',
        isError: true,
      });
    }
    const token = restoreToken();
    setIdToken(token ? token.idToken : null);
    setAuthChecked(true);
  }, []);

  // 認証済みになったらクイズ一覧を読み込む。
  useEffect(() => {
    if (!idToken) {
      return;
    }
    let cancelled = false;
    setStatus({ message: 'クイズを読み込み中...', isError: false });
    void (async () => {
      try {
        const data = await getQuizzes();
        if (cancelled) {
          return;
        }
        setQuizzes(data.quizzes || []);
        if (data.quizzes && data.quizzes.length > 0) {
          setSelectedQuizId(data.quizzes[0].quizId);
        }
        setStatus(EMPTY_STATUS);
      } catch (err) {
        if (!cancelled) {
          setStatus({ message: errorMessage(err), isError: true });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idToken]);

  // WebSocket 接続はホストとして認証済みになった時点で確立する。
  useEffect(() => {
    if (!idToken) {
      return;
    }
    const socket = new BattleSocket({
      onOpen: () => {
        setConnStatus('open');
        // 既存ルームがある状態で（再）接続できたら reattachRoom で復帰する。
        const currentRoom = roomIdRef.current;
        const currentToken = idTokenRef.current;
        if (currentRoom && currentToken) {
          socket.send('reattachRoom', { token: currentToken, roomId: currentRoom });
        }
      },
      onClose: () => setConnStatus('closed'),
      onError: () => setConnStatus('error'),
      onMessage: (msg) => handleMessage(msg),
    });
    socketRef.current = socket;
    setConnStatus('connecting');
    try {
      socket.connect();
    } catch (err) {
      setConnStatus('error');
      setStatus({ message: errorMessage(err), isError: true });
    }
    return () => {
      socket.close();
      socketRef.current = null;
    };
    // handleMessage は state セッターのみ参照するため依存に含めない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idToken]);

  function handleMessage(msg: InboundMessage): void {
    switch (msg.type) {
      case 'roomCreated':
        setRoomId(msg.roomId);
        setStatus({
          message:
            'ルームを作成しました。ルーム ID を参加者に共有してください。',
          isError: false,
        });
        break;
      case 'state':
        setLive({
          phase: msg.phase,
          currentQuestion: msg.currentQuestion,
          questionCount: msg.questionCount,
          quizTitle: msg.quizTitle,
          question: msg.question,
          scoreboard: msg.scoreboard,
          hostConnected: msg.hostConnected,
        });
        break;
      case 'error':
        setStatus({ message: msg.message, isError: true });
        break;
      default:
        // roomCreated/state/error 以外（joined/answerAck）はホストでは使わない。
        break;
    }
  }

  function handleLogin(): void {
    window.location.assign(loginUrl());
  }

  function handleLogout(): void {
    clearToken();
    setIdToken(null);
    window.location.assign(logoutUrl());
  }

  function createRoom(): void {
    const socket = socketRef.current;
    if (!socket || !idToken) {
      return;
    }
    if (!selectedQuizId) {
      setStatus({ message: 'クイズを選択してください。', isError: true });
      return;
    }
    const sent = socket.send('createRoom', {
      token: idToken,
      quizId: selectedQuizId,
    });
    if (!sent) {
      setStatus({
        message: 'サーバーに接続していません。少し待って再試行してください。',
        isError: true,
      });
    }
  }

  function startGame(): void {
    const socket = socketRef.current;
    if (!socket || !idToken || !roomId) {
      return;
    }
    socket.send('startGame', { token: idToken, roomId });
  }

  function nextQuestion(): void {
    const socket = socketRef.current;
    if (!socket || !idToken || !roomId) {
      return;
    }
    socket.send('nextQuestion', { token: idToken, roomId });
  }

  function endGame(): void {
    const socket = socketRef.current;
    if (!socket || !idToken || !roomId) {
      return;
    }
    socket.send('endGame', { token: idToken, roomId });
  }

  if (!authChecked) {
    return <p className="status">認証状態を確認中...</p>;
  }

  // 未ログインならログインを促す（Hosted UI へリダイレクト）。
  if (!idToken) {
    return (
      <div className="battle-host login-view">
        <p>ホストとしてルームを作成するにはログインが必要です。</p>
        {status.message && (
          <p className={status.isError ? 'status error' : 'status'}>
            {status.message}
          </p>
        )}
        <div className="quiz-actions">
          <button type="button" className="btn primary" onClick={handleLogin}>
            ログイン
          </button>
          <button type="button" className="btn" onClick={onBack}>
            戻る
          </button>
        </div>
      </div>
    );
  }

  const phase = live?.phase ?? 'lobby';

  return (
    <div className="battle-host">
      <div className="admin-toolbar">
        <button type="button" className="btn small" onClick={handleLogout}>
          ログアウト
        </button>
      </div>

      <ConnectionBadge status={connStatus} />

      {status.message && (
        <p className={status.isError ? 'status error' : 'status'}>
          {status.message}
        </p>
      )}

      {/* ルーム未作成: クイズを選んで作成する。 */}
      {!roomId && (
        <div className="card battle-host-setup">
          <div className="admin-field">
            <label htmlFor="battle-quiz-select">出題するクイズ</label>
            {quizzes.length === 0 ? (
              <p className="empty-state">
                登録済みのクイズがありません。管理者ページで作成してください。
              </p>
            ) : (
              <select
                id="battle-quiz-select"
                className="admin-input"
                value={selectedQuizId}
                onChange={(e) => setSelectedQuizId(e.target.value)}
              >
                {quizzes.map((quiz) => (
                  <option key={quiz.quizId} value={quiz.quizId}>
                    {quiz.title}（全{quiz.questionCount}問）
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="quiz-actions">
            <button type="button" className="btn" onClick={onBack}>
              戻る
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={quizzes.length === 0 || connStatus !== 'open'}
              onClick={createRoom}
            >
              ルームを作成
            </button>
          </div>
        </div>
      )}

      {/* ルーム作成済み: 共有 ID と進行コントロール。 */}
      {roomId && (
        <>
          <div className="card battle-roomid-card">
            <span className="battle-roomid-label">ルーム ID</span>
            <span className="battle-roomid-value">{roomId}</span>
            <span className="battle-roomid-note">
              参加者にこの ID を共有してください。
            </span>
          </div>

          {live && (
            <LiveQuestion
              live={live}
              selectedIndex={null}
              answered={false}
              onSelect={() => undefined}
              onSubmit={() => undefined}
              interactive={false}
            />
          )}

          <div className="quiz-actions battle-host-controls">
            {phase === 'lobby' && (
              <button
                type="button"
                className="btn primary"
                onClick={startGame}
              >
                ゲーム開始
              </button>
            )}
            {(phase === 'in_question' || phase === 'between') && (
              <button
                type="button"
                className="btn primary"
                onClick={nextQuestion}
              >
                {phase === 'in_question' ? '正解を表示' : '次の設問へ'}
              </button>
            )}
            {phase !== 'finished' && (
              <button type="button" className="btn" onClick={endGame}>
                終了する
              </button>
            )}
            {phase === 'finished' && (
              <button type="button" className="btn primary" onClick={onBack}>
                対戦を終える
              </button>
            )}
          </div>

          {phase === 'finished' && (
            <p className="battle-phase-note">対戦が終了しました。最終順位:</p>
          )}

          {live && <Scoreboard scoreboard={live.scoreboard} />}
        </>
      )}
    </div>
  );
}

// ---- 参加者 --------------------------------------------------------------

function ParticipantBattle({ onBack }: { onBack: () => void }) {
  const [status, setStatus] = useState<Status>(EMPTY_STATUS);
  const [connStatus, setConnStatus] = useState<ConnectionStatus>('connecting');

  const [name, setName] = useState('');
  const [roomIdInput, setRoomIdInput] = useState('');
  const [joinedName, setJoinedName] = useState<string | null>(null);
  const [live, setLive] = useState<LiveState | null>(null);

  // 現在の設問に対する選択・回答済み状態。設問が変わるたびにリセットする。
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [answeredForN, setAnsweredForN] = useState<number | null>(null);

  const socketRef = useRef<BattleSocket | null>(null);

  const handleMessage = useCallback((msg: InboundMessage): void => {
    switch (msg.type) {
      case 'joined':
        setJoinedName(msg.name);
        setStatus({
          message: 'ルームに参加しました。開始をお待ちください。',
          isError: false,
        });
        break;
      case 'state':
        setLive((prev) => {
          // 設問が切り替わったら選択状態をリセットする。
          if (
            msg.phase === 'in_question' &&
            (!prev || prev.currentQuestion !== msg.currentQuestion)
          ) {
            setSelectedIndex(null);
          }
          return {
            phase: msg.phase,
            currentQuestion: msg.currentQuestion,
            questionCount: msg.questionCount,
            quizTitle: msg.quizTitle,
            question: msg.question,
            scoreboard: msg.scoreboard,
            hostConnected: msg.hostConnected,
          };
        });
        break;
      case 'answerAck':
        setAnsweredForN(msg.n);
        setStatus({
          message: msg.correct ? '正解！' : '不正解…',
          isError: false,
        });
        break;
      case 'error':
        setStatus({ message: msg.message, isError: true });
        break;
      default:
        break;
    }
  }, []);

  // WebSocket は参加フォーム送信時に接続する（マウント時ではなく join 時）。
  useEffect(() => {
    return () => {
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  function handleJoin(event: FormEvent): void {
    event.preventDefault();
    const trimmedName = name.trim();
    const trimmedRoom = roomIdInput.trim().toUpperCase();
    if (!trimmedName) {
      setStatus({ message: '表示名を入力してください。', isError: true });
      return;
    }
    if (!trimmedRoom) {
      setStatus({ message: 'ルーム ID を入力してください。', isError: true });
      return;
    }

    // 既存接続があれば閉じてから開き直す。
    socketRef.current?.close();

    const socket = new BattleSocket({
      onOpen: () => {
        setConnStatus('open');
        // 接続が開いたら join を送る。
        socket.send('joinRoom', { name: trimmedName, roomId: trimmedRoom });
      },
      onClose: () => setConnStatus('closed'),
      onError: () => setConnStatus('error'),
      onMessage: (msg) => handleMessage(msg),
    });
    socketRef.current = socket;
    setConnStatus('connecting');
    setStatus({ message: '接続中...', isError: false });
    try {
      socket.connect();
    } catch (err) {
      setConnStatus('error');
      setStatus({ message: errorMessage(err), isError: true });
    }
  }

  function submitAnswer(): void {
    const socket = socketRef.current;
    if (!socket || selectedIndex === null) {
      return;
    }
    // 参加者は answerIndex のみ送る（ルーム / 名前はサーバーが接続から特定）。
    const sent = socket.send('submitAnswer', { answerIndex: selectedIndex });
    if (!sent) {
      setStatus({
        message: 'サーバーに接続していません。',
        isError: true,
      });
    }
  }

  // 参加前: 名前 + ルーム ID フォーム。
  if (!joinedName) {
    return (
      <div className="battle-join">
        {status.message && (
          <p className={status.isError ? 'status error' : 'status'}>
            {status.message}
          </p>
        )}
        <form className="card battle-join-form" onSubmit={handleJoin}>
          <div className="admin-field">
            <label htmlFor="battle-name">表示名</label>
            <input
              id="battle-name"
              className="admin-input"
              type="text"
              maxLength={40}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="例: たろう"
            />
          </div>
          <div className="admin-field">
            <label htmlFor="battle-room">ルーム ID</label>
            <input
              id="battle-room"
              className="admin-input battle-room-input"
              type="text"
              value={roomIdInput}
              onChange={(e) => setRoomIdInput(e.target.value)}
              placeholder="例: ABC234"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          <div className="quiz-actions">
            <button type="button" className="btn" onClick={onBack}>
              戻る
            </button>
            <button type="submit" className="btn primary">
              参加する
            </button>
          </div>
        </form>
      </div>
    );
  }

  // 参加後: 接続状態 + ライブ設問 + 順位表。
  const answered =
    live?.phase === 'in_question' &&
    live.currentQuestion === answeredForN;

  return (
    <div className="battle-participant">
      <ConnectionBadge status={connStatus} />

      <p className="battle-me">あなた: {joinedName}</p>

      {status.message && (
        <p className={status.isError ? 'status error' : 'status'}>
          {status.message}
        </p>
      )}

      {live && !live.hostConnected && live.phase !== 'finished' && (
        <p className="battle-phase-note battle-host-away">
          ホストが一時的に離席中です。再接続をお待ちください。
        </p>
      )}

      {live && (
        <LiveQuestion
          live={live}
          selectedIndex={selectedIndex}
          answered={Boolean(answered)}
          onSelect={setSelectedIndex}
          onSubmit={submitAnswer}
          interactive={true}
        />
      )}

      {live?.phase === 'finished' && (
        <p className="battle-phase-note">対戦が終了しました。最終順位:</p>
      )}

      {live && (
        <Scoreboard scoreboard={live.scoreboard} highlightName={joinedName} />
      )}

      <div className="quiz-actions">
        <button
          type="button"
          className="btn"
          onClick={() => {
            socketRef.current?.close();
            onBack();
          }}
        >
          退出する
        </button>
      </div>
    </div>
  );
}

// ---- ユーティリティ --------------------------------------------------------

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
