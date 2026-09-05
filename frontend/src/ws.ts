// リアルタイム対戦用の WebSocket ラッパー。ネイティブ `WebSocket` の薄い型付き
// ラッパーで、新しい依存は一切追加しない（react + react-dom のみ）。
//
// メッセージ / アクションの契約は backend（lambda/ws.ts / FEAT-002）と完全に一致させる:
//   CLIENT->SERVER: { action, ...payload } の JSON テキストフレーム
//   SERVER->CLIENT: { type, ... } の JSON テキストフレーム
// 参加者は answerIndex を一切受け取らない（サーバーは in_question 中でも question に
// answerIndex を含めない）。採点はサーバー側でのみ行われる。

import { WS_URL } from './config';

// ---- ゲームフェーズ / スコアボード -----------------------------------------

/** ゲームの進行フェーズ（lambda/ws.ts の state machine と一致）。 */
export type BattlePhase = 'lobby' | 'in_question' | 'between' | 'finished';

/** 参加者に配信される設問（answerIndex は含まれない）。 */
export interface ParticipantQuestion {
  n: number;
  text: string;
  options: string[];
}

/** ライブ順位表の 1 行（score 降順、同点は name 昇順でサーバーがソート済み）。 */
export interface ScoreboardEntry {
  name: string;
  score: number;
}

// ---- SERVER -> CLIENT メッセージ（判別可能ユニオン） -----------------------

/** createRoom 後、ホストにのみ送られる。 */
export interface RoomCreatedMessage {
  type: 'roomCreated';
  roomId: string;
  quizId: string;
  quizTitle: string;
  questionCount: number;
}

/** joinRoom 後、参加した本人にのみ送られる。 */
export interface JoinedMessage {
  type: 'joined';
  roomId: string;
  name: string;
  quizTitle: string;
  questionCount: number;
}

/**
 * ルーム内の全接続にブロードキャストされるゲーム状態。フェーズ遷移や
 * スコアボード変化のたびに送られる。question は phase==='in_question' の
 * ときだけ存在し、決して answerIndex を含まない。
 */
export interface StateMessage {
  type: 'state';
  roomId: string;
  phase: BattlePhase;
  currentQuestion: number;
  questionCount: number;
  quizTitle: string;
  question: ParticipantQuestion | null;
  scoreboard: ScoreboardEntry[];
  // ホストが切断中（away）でもルームは保持され、ホストは reattachRoom で復帰できる。
  // false の間はクライアントで「ホストが一時的に離席中」を表示するために使う。
  hostConnected: boolean;
}

/** submitAnswer した参加者本人にのみ送られる正誤結果（answerIndex は含まれない）。 */
export interface AnswerAckMessage {
  type: 'answerAck';
  n: number;
  correct: boolean;
}

/** 拒否された / 無効な操作に対して 1 接続にのみ送られるエラー。 */
export interface ErrorMessage {
  type: 'error';
  message: string;
}

/** SERVER -> CLIENT メッセージの判別可能ユニオン。 */
export type InboundMessage =
  | RoomCreatedMessage
  | JoinedMessage
  | StateMessage
  | AnswerAckMessage
  | ErrorMessage;

// ---- CLIENT -> SERVER アクション -------------------------------------------

/** ホスト: 既存クイズからルームを作成する（id トークン必須）。 */
export interface CreateRoomAction {
  token: string;
  quizId: string;
}

/** 参加者: 表示名 + ルーム ID で参加する（トークン不要）。 */
export interface JoinRoomAction {
  name: string;
  roomId: string;
}

/**
 * ホスト: 一時切断後に既存ルームへ再接続する（token の sub が hostSub と一致する
 * 場合のみ許可）。hostConnId を新しい接続に付け替え、ルームの進行状態を維持したまま
 * 操作を再開する。成功時はサーバーが roomCreated と同形のメッセージを返す。
 */
export interface ReattachRoomAction {
  token: string;
  roomId: string;
}

/** ホスト: ゲームを開始する。 */
export interface StartGameAction {
  token: string;
  roomId: string;
}

/**
 * 参加者: 回答を送信する。ルーム / 名前は接続からサーバーが特定するため、
 * answerIndex のみを送る（トークン / roomId / name は不要）。
 */
export interface SubmitAnswerAction {
  answerIndex: number;
}

/** ホスト: 次の設問（in_question->between の正解表示、その後 between->次 or finished）。 */
export interface NextQuestionAction {
  token: string;
  roomId: string;
}

/** ホスト: ゲームを終了する。 */
export interface EndGameAction {
  token: string;
  roomId: string;
}

/** action 名 -> ペイロード型のマップ。send() の型付けに使う。 */
export interface OutboundActionMap {
  createRoom: CreateRoomAction;
  reattachRoom: ReattachRoomAction;
  joinRoom: JoinRoomAction;
  startGame: StartGameAction;
  submitAnswer: SubmitAnswerAction;
  nextQuestion: NextQuestionAction;
  endGame: EndGameAction;
}

export type OutboundAction = keyof OutboundActionMap;

// ---- 接続状態 --------------------------------------------------------------

/** UI に表示する接続状態。 */
export type ConnectionStatus =
  | 'connecting'
  | 'open'
  | 'closed'
  | 'error';

/** BattleSocket のイベントハンドラ。 */
export interface BattleSocketHandlers {
  /** サーバーからの JSON メッセージ（パース済み・型付き）。 */
  onMessage?: (message: InboundMessage) => void;
  /** 接続が開いたとき。 */
  onOpen?: () => void;
  /** 接続が閉じたとき。 */
  onClose?: (event: CloseEvent) => void;
  /** 低レベルのエラー（接続失敗など）。 */
  onError?: (event: Event) => void;
}

/**
 * ネイティブ WebSocket の薄い型付きラッパー。connect() で `new WebSocket(WS_URL)`
 * を開き、send(action, payload) で {action, ...payload} を JSON 送信し、
 * 受信メッセージをパースして型付きの InboundMessage としてハンドラに渡す。
 */
export class BattleSocket {
  private ws: WebSocket | null = null;
  private handlers: BattleSocketHandlers;
  private closedByClient = false;

  constructor(handlers: BattleSocketHandlers = {}) {
    this.handlers = handlers;
  }

  /** WS_URL へ接続する。WS_URL 未設定の場合は例外を投げる。 */
  connect(): void {
    if (!WS_URL) {
      throw new Error(
        'WebSocket エンドポイントが設定されていません（VITE_WS_URL）。',
      );
    }
    this.closedByClient = false;
    const ws = new WebSocket(WS_URL);
    this.ws = ws;

    ws.onopen = () => {
      this.handlers.onOpen?.();
    };

    ws.onmessage = (event: MessageEvent) => {
      const parsed = this.parseMessage(event.data);
      if (parsed) {
        this.handlers.onMessage?.(parsed);
      }
    };

    ws.onclose = (event: CloseEvent) => {
      this.handlers.onClose?.(event);
    };

    ws.onerror = (event: Event) => {
      this.handlers.onError?.(event);
    };
  }

  /** 現在接続が開いているか。 */
  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** クライアント側から明示的に閉じたか（再接続判定に利用可能）。 */
  wasClosedByClient(): boolean {
    return this.closedByClient;
  }

  /**
   * {action, ...payload} を JSON 文字列にして送信する。接続が開いていない
   * 場合は false を返す（呼び出し側で状態を確認できる）。
   */
  send<A extends OutboundAction>(
    action: A,
    payload: OutboundActionMap[A],
  ): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return false;
    }
    this.ws.send(JSON.stringify({ action, ...payload }));
    return true;
  }

  /** 接続を閉じる。 */
  close(): void {
    this.closedByClient = true;
    if (this.ws) {
      // ハンドラ経由の再入を避けるため、閉じる前にリスナーを外す必要は無いが、
      // onclose は closedByClient を見て再接続しないよう呼び出し側で判断できる。
      this.ws.close();
      this.ws = null;
    }
  }

  /** 受信データを型付き InboundMessage にパースする。未知/不正なら null。 */
  private parseMessage(data: unknown): InboundMessage | null {
    if (typeof data !== 'string') {
      return null;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(data);
    } catch {
      return null;
    }
    if (
      obj &&
      typeof obj === 'object' &&
      typeof (obj as { type?: unknown }).type === 'string'
    ) {
      return obj as InboundMessage;
    }
    return null;
  }
}
