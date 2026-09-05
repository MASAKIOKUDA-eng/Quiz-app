import type { APIGatewayProxyWebsocketEventV2 } from 'aws-lambda';
import * as crypto from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  GetCommand,
  PutCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';

/**
 * Realtime battle WebSocket handler (FEAT-002).
 *
 * Server-authoritative game state machine for a synchronous multiplayer
 * quiz battle. A HOST (an authenticated Cognito admin) creates a room from
 * an existing registered quiz, shares the short room id, participants join
 * with just a display name + room id (NO login), the host starts and steps
 * through the quiz, the SAME question is pushed to every participant, and a
 * live scoreboard (participant names + scores) is broadcast.
 *
 * Security-critical invariants:
 *   - The stored `answerIndex` is NEVER broadcast to any connection. Scoring
 *     happens here on the server using the stored answerIndex.
 *   - Host-only actions (createRoom / startGame / nextQuestion / endGame)
 *     require a verified Cognito id token (iss + aud + RS256 signature +
 *     exp + token_use). Participant actions (joinRoom / submitAnswer) need
 *     no token.
 *
 * Data model (SAME single table; QUIZ# items are untouched):
 *   Room meta:   pk=ROOM#<roomId>  sk=META
 *                { roomId, hostSub, hostConnId, quizId, quizTitle,
 *                  questionCount, phase, currentQuestion, createdAt, ttl }
 *   Connection:  pk=ROOM#<roomId>  sk=CONN#<connectionId>
 *                { connectionId, name, role, ttl }
 *   Player:      pk=ROOM#<roomId>  sk=PLAYER#<name>
 *                { name, score, answeredForQuestion, ttl }
 *   Conn lookup: pk=CONN#<connectionId>  sk=META
 *                { roomId, name, role, ttl }
 *
 * The pure helpers (generateRoomId, aggregateScoreboard, nextGamePhase,
 * toParticipantQuestion, scoreSingleAnswer, validateJoinInput) contain NO
 * AWS SDK calls so they can be unit-tested in isolation.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GamePhase = 'lobby' | 'in_question' | 'between' | 'finished';

export interface PlayerScore {
  name: string;
  score: number;
}

export interface ScoreboardEntry {
  name: string;
  score: number;
}

export interface StoredQuestion {
  n: number;
  text: string;
  options: string[];
  answerIndex: number;
}

export interface ParticipantQuestion {
  n: number;
  text: string;
  options: string[];
}

// ---------------------------------------------------------------------------
// PURE helpers (no AWS SDK) — exported for unit testing.
// ---------------------------------------------------------------------------

/**
 * Alphabet for shareable room ids. Deliberately excludes ambiguous glyphs
 * (0/O, 1/I/L) so a code read aloud or typed by a participant is unambiguous.
 */
export const ROOM_ID_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const ROOM_ID_LENGTH = 6;
const ROOM_ID_PATTERN = new RegExp(`^[${ROOM_ID_ALPHABET}]{${ROOM_ID_LENGTH}}$`);

/**
 * Generate a short, human-shareable room id (6 chars from an unambiguous
 * alphabet). Uses crypto.randomInt for uniform, unpredictable selection.
 */
export function generateRoomId(): string {
  let out = '';
  for (let i = 0; i < ROOM_ID_LENGTH; i++) {
    out += ROOM_ID_ALPHABET[crypto.randomInt(ROOM_ID_ALPHABET.length)];
  }
  return out;
}

/** True when a string has the exact room-id shape (used for join validation). */
export function isValidRoomId(roomId: unknown): roomId is string {
  return typeof roomId === 'string' && ROOM_ID_PATTERN.test(roomId);
}

/**
 * Aggregate + sort players into a live scoreboard: score descending, then
 * name ascending for a stable, deterministic tie-break. Pure.
 */
export function aggregateScoreboard(players: PlayerScore[]): ScoreboardEntry[] {
  return players
    .map((p) => ({ name: p.name, score: p.score }))
    .sort((a, b) => (b.score - a.score) || a.name.localeCompare(b.name));
}

/**
 * Game-state machine. Given the current phase, the total question count and
 * the current question index, return the NEXT phase when the host advances:
 *
 *   lobby        --startGame-->    in_question (question 0)
 *   in_question  --(reveal)-->     between
 *   between      --nextQuestion--> in_question (next) OR finished (last)
 *   finished     -->              finished (terminal)
 *
 * `currentIndex` is the 0-based index of the question currently shown/just
 * finished. When advancing from `between`, if there is no further question
 * (currentIndex is the last), the game is `finished`.
 */
export function nextGamePhase(
  current: GamePhase,
  questionCount: number,
  currentIndex: number,
): GamePhase {
  switch (current) {
    case 'lobby':
      return questionCount > 0 ? 'in_question' : 'finished';
    case 'in_question':
      return 'between';
    case 'between':
      return currentIndex + 1 < questionCount ? 'in_question' : 'finished';
    case 'finished':
    default:
      return 'finished';
  }
}

/**
 * Project a stored question to the participant-safe shape, DROPPING
 * answerIndex (and any other server-only field). Mirrors the HTTP handler's
 * toPublicQuestions. Never returns answerIndex.
 */
export function toParticipantQuestion(
  question: StoredQuestion,
): ParticipantQuestion {
  return { n: question.n, text: question.text, options: question.options };
}

/** True when a submitted option index matches the stored correct answer. */
export function scoreSingleAnswer(
  answerIndex: number,
  submittedIndex: number,
): boolean {
  return (
    Number.isInteger(submittedIndex) && submittedIndex === answerIndex
  );
}

export type ValidateJoinResult =
  | { ok: true; name: string; roomId: string }
  | { ok: false; error: string };

/**
 * Validate + normalize a participant join payload: a non-empty display name
 * (trimmed, bounded length) and a well-formed room id. Pure.
 */
export function validateJoinInput(input: unknown): ValidateJoinResult {
  if (typeof input !== 'object' || input === null) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj.name !== 'string' || obj.name.trim().length === 0) {
    return { ok: false, error: 'name must be a non-empty string' };
  }
  const name = obj.name.trim();
  if (name.length > 40) {
    return { ok: false, error: 'name must be at most 40 characters' };
  }

  const roomId =
    typeof obj.roomId === 'string' ? obj.roomId.trim().toUpperCase() : obj.roomId;
  if (!isValidRoomId(roomId)) {
    return { ok: false, error: 'roomId is invalid' };
  }

  return { ok: true, name, roomId };
}

// ---------------------------------------------------------------------------
// AWS-touching code below (NOT exported so the pure helpers can be imported
// without an AWS SDK dependency).
// ---------------------------------------------------------------------------

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

// Rooms/connections auto-expire after this bounded window (seconds). A battle
// session is short-lived; TTL keeps the table clean at no cost.
const TTL_WINDOW_SECONDS = 6 * 60 * 60; // 6 hours

function tableName(): string {
  const name = process.env.TABLE_NAME;
  if (!name) {
    throw new Error('TABLE_NAME environment variable is not set');
  }
  return name;
}

function ttlEpoch(): number {
  return Math.floor(Date.now() / 1000) + TTL_WINDOW_SECONDS;
}

// --- DynamoDB item shapes ---------------------------------------------------

interface RoomMetaItem {
  pk: string;
  sk: 'META';
  type: 'ROOM';
  roomId: string;
  hostSub: string;
  hostConnId: string;
  quizId: string;
  quizTitle: string;
  questionCount: number;
  phase: GamePhase;
  currentQuestion: number;
  createdAt: number;
  ttl: number;
}

interface ConnItem {
  pk: string;
  sk: string; // CONN#<connectionId>
  type: 'CONN';
  connectionId: string;
  name: string;
  role: 'host' | 'player';
  ttl: number;
}

interface PlayerItem {
  pk: string;
  sk: string; // PLAYER#<name>
  type: 'PLAYER';
  name: string;
  score: number;
  answeredForQuestion: number; // last question index answered (-1 = none)
  ttl: number;
}

interface ConnLookupItem {
  pk: string; // CONN#<connectionId>
  sk: 'META';
  type: 'CONN_LOOKUP';
  roomId: string;
  name: string;
  role: 'host' | 'player';
  ttl: number;
}

const roomPk = (roomId: string) => `ROOM#${roomId}`;
const connSk = (connectionId: string) => `CONN#${connectionId}`;
const playerSk = (name: string) => `PLAYER#${name}`;
const connLookupPk = (connectionId: string) => `CONN#${connectionId}`;

// --- Cognito host JWT verification -----------------------------------------

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
  use?: string;
}

// Module-scope JWKS cache so a warm Lambda avoids re-fetching the keys.
let jwksCache: Jwk[] | null = null;

function b64urlToBuffer(input: string): Buffer {
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4));
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function b64urlToJson(input: string): Record<string, unknown> {
  return JSON.parse(b64urlToBuffer(input).toString('utf8'));
}

async function getJwks(issuer: string): Promise<Jwk[]> {
  if (jwksCache) {
    return jwksCache;
  }
  const url = `${issuer}/.well-known/jwks.json`;
  // Node 22 provides a global fetch.
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch JWKS: ${res.status}`);
  }
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache = body.keys;
  return jwksCache;
}

/**
 * Verify a Cognito id token: RS256 signature against the pool JWKS, plus
 * iss / aud / exp / token_use checks. Returns the `sub` claim on success or
 * null on any failure. Keeps AWS/crypto usage out of the exported pure
 * helpers.
 */
async function verifyHostToken(token: unknown): Promise<string | null> {
  const issuer = process.env.COGNITO_ISSUER;
  const clientId = process.env.COGNITO_CLIENT_ID;
  if (!issuer || !clientId) {
    return null;
  }
  if (typeof token !== 'string' || token.length === 0) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = b64urlToJson(headerB64);
    payload = b64urlToJson(payloadB64);
  } catch {
    return null;
  }

  if (header.alg !== 'RS256' || typeof header.kid !== 'string') {
    return null;
  }

  // Claim checks.
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp < now) {
    return null;
  }
  if (payload.iss !== issuer) {
    return null;
  }
  // Cognito id tokens carry `aud` (the app client id) and token_use 'id'.
  if (payload.aud !== clientId) {
    return null;
  }
  if (payload.token_use !== undefined && payload.token_use !== 'id') {
    return null;
  }

  // Signature verification (RS256) against the matching JWK.
  let keys: Jwk[];
  try {
    keys = await getJwks(issuer);
  } catch {
    return null;
  }
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    // Key rotation: refresh the cache once and retry.
    jwksCache = null;
    try {
      keys = await getJwks(issuer);
    } catch {
      return null;
    }
    jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) {
      return null;
    }
  }

  try {
    const keyObject = crypto.createPublicKey({
      key: {
        kty: jwk.kty,
        n: jwk.n,
        e: jwk.e,
      },
      format: 'jwk',
    });
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(`${headerB64}.${payloadB64}`);
    verifier.end();
    const valid = verifier.verify(keyObject, b64urlToBuffer(signatureB64));
    if (!valid) {
      return null;
    }
  } catch {
    return null;
  }

  return typeof payload.sub === 'string' ? payload.sub : null;
}

// --- DynamoDB access --------------------------------------------------------

async function getRoom(roomId: string): Promise<RoomMetaItem | undefined> {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: roomPk(roomId), sk: 'META' },
    }),
  );
  return res.Item as RoomMetaItem | undefined;
}

async function getConnLookup(
  connectionId: string,
): Promise<ConnLookupItem | undefined> {
  const res = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: connLookupPk(connectionId), sk: 'META' },
    }),
  );
  return res.Item as ConnLookupItem | undefined;
}

async function listRoomConnections(roomId: string): Promise<ConnItem[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :conn)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': roomPk(roomId), ':conn': 'CONN#' },
    }),
  );
  return (res.Items ?? []) as ConnItem[];
}

async function listRoomPlayers(roomId: string): Promise<PlayerItem[]> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :player)',
      ExpressionAttributeNames: { '#pk': 'pk', '#sk': 'sk' },
      ExpressionAttributeValues: { ':pk': roomPk(roomId), ':player': 'PLAYER#' },
    }),
  );
  return (res.Items ?? []) as PlayerItem[];
}

/** Load a quiz's questions (with answerIndex) reusing the QUIZ# item shapes. */
async function getQuizQuestions(quizId: string): Promise<{
  meta?: { quizId: string; title: string; questionCount: number };
  questions: StoredQuestion[];
}> {
  const res = await ddb.send(
    new QueryCommand({
      TableName: tableName(),
      KeyConditionExpression: '#pk = :pk',
      ExpressionAttributeNames: { '#pk': 'pk' },
      ExpressionAttributeValues: { ':pk': `QUIZ#${quizId}` },
    }),
  );
  const items = (res.Items ?? []) as Record<string, unknown>[];
  let meta: { quizId: string; title: string; questionCount: number } | undefined;
  const questions: StoredQuestion[] = [];
  for (const item of items) {
    if (item.sk === 'META') {
      meta = {
        quizId: item.quizId as string,
        title: item.title as string,
        questionCount: item.questionCount as number,
      };
    } else if (item.type === 'QUESTION') {
      questions.push({
        n: item.n as number,
        text: item.text as string,
        options: item.options as string[],
        answerIndex: item.answerIndex as number,
      });
    }
  }
  questions.sort((a, b) => a.n - b.n);
  return { meta, questions };
}

// --- Broadcasting -----------------------------------------------------------

interface RoomStateMessage {
  type: 'state';
  roomId: string;
  phase: GamePhase;
  currentQuestion: number;
  questionCount: number;
  quizTitle: string;
  // Participant-safe question (NO answerIndex). Present only in_question.
  question: ParticipantQuestion | null;
  scoreboard: ScoreboardEntry[];
}

function mgmtClient(domainName: string, stage: string): ApiGatewayManagementApiClient {
  return new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });
}

async function postToConnection(
  client: ApiGatewayManagementApiClient,
  roomId: string,
  connectionId: string,
  payload: unknown,
): Promise<void> {
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify(payload)),
      }),
    );
  } catch (err) {
    if (err instanceof GoneException || (err as { name?: string }).name === 'GoneException') {
      // Stale connection: clean up its items so it stops receiving broadcasts.
      await removeConnection(roomId, connectionId).catch(() => undefined);
    } else {
      // eslint-disable-next-line no-console
      console.error('postToConnection error', err);
    }
  }
}

/** Send a private error message back to a single connection. */
async function sendError(
  domainName: string,
  stage: string,
  connectionId: string,
  message: string,
): Promise<void> {
  const client = mgmtClient(domainName, stage);
  try {
    await client.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: Buffer.from(JSON.stringify({ type: 'error', message })),
      }),
    );
  } catch {
    // best-effort
  }
}

/**
 * Build the participant-safe room state message. NEVER includes answerIndex:
 * the question is projected via toParticipantQuestion.
 */
function buildStateMessage(
  room: RoomMetaItem,
  players: PlayerItem[],
  currentStoredQuestion: StoredQuestion | null,
): RoomStateMessage {
  return {
    type: 'state',
    roomId: room.roomId,
    phase: room.phase,
    currentQuestion: room.currentQuestion,
    questionCount: room.questionCount,
    quizTitle: room.quizTitle,
    question:
      room.phase === 'in_question' && currentStoredQuestion
        ? toParticipantQuestion(currentStoredQuestion)
        : null,
    scoreboard: aggregateScoreboard(
      players.map((p) => ({ name: p.name, score: p.score })),
    ),
  };
}

/** Broadcast the current room state to every connection in the room. */
async function broadcastState(
  domainName: string,
  stage: string,
  roomId: string,
): Promise<void> {
  const room = await getRoom(roomId);
  if (!room) {
    return;
  }
  const [connections, players] = await Promise.all([
    listRoomConnections(roomId),
    listRoomPlayers(roomId),
  ]);

  let currentStoredQuestion: StoredQuestion | null = null;
  if (room.phase === 'in_question') {
    const { questions } = await getQuizQuestions(room.quizId);
    currentStoredQuestion = questions[room.currentQuestion] ?? null;
  }

  const message = buildStateMessage(room, players, currentStoredQuestion);
  const client = mgmtClient(domainName, stage);
  await Promise.all(
    connections.map((c) =>
      postToConnection(client, roomId, c.connectionId, message),
    ),
  );
}

async function removeConnection(
  roomId: string,
  connectionId: string,
): Promise<void> {
  await Promise.all([
    ddb.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { pk: roomPk(roomId), sk: connSk(connectionId) },
      }),
    ),
    ddb.send(
      new DeleteCommand({
        TableName: tableName(),
        Key: { pk: connLookupPk(connectionId), sk: 'META' },
      }),
    ),
  ]);
}

// --- Action handlers --------------------------------------------------------

interface ActionCtx {
  connectionId: string;
  domainName: string;
  stage: string;
}

async function handleCreateRoom(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<void> {
  const hostSub = await verifyHostToken(body.token);
  if (!hostSub) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'unauthorized: valid host token required');
    return;
  }
  const quizId = body.quizId;
  if (typeof quizId !== 'string' || quizId.length === 0) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'quizId is required');
    return;
  }
  const { meta } = await getQuizQuestions(quizId);
  if (!meta) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'quiz not found');
    return;
  }

  // Generate a room id, retrying on the rare collision.
  let roomId = generateRoomId();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await getRoom(roomId);
    if (!existing) {
      break;
    }
    roomId = generateRoomId();
  }

  const ttl = ttlEpoch();
  const room: RoomMetaItem = {
    pk: roomPk(roomId),
    sk: 'META',
    type: 'ROOM',
    roomId,
    hostSub,
    hostConnId: ctx.connectionId,
    quizId,
    quizTitle: meta.title,
    questionCount: meta.questionCount,
    phase: 'lobby',
    currentQuestion: -1,
    createdAt: Date.now(),
    ttl,
  };
  const connItem: ConnItem = {
    pk: roomPk(roomId),
    sk: connSk(ctx.connectionId),
    type: 'CONN',
    connectionId: ctx.connectionId,
    name: '__host__',
    role: 'host',
    ttl,
  };
  const lookup: ConnLookupItem = {
    pk: connLookupPk(ctx.connectionId),
    sk: 'META',
    type: 'CONN_LOOKUP',
    roomId,
    name: '__host__',
    role: 'host',
    ttl,
  };

  await Promise.all([
    ddb.send(new PutCommand({ TableName: tableName(), Item: room })),
    ddb.send(new PutCommand({ TableName: tableName(), Item: connItem })),
    ddb.send(new PutCommand({ TableName: tableName(), Item: lookup })),
  ]);

  // Tell the host the room was created (so it can show/share the room id),
  // then broadcast the (empty) lobby state.
  const client = mgmtClient(ctx.domainName, ctx.stage);
  await postToConnection(client, roomId, ctx.connectionId, {
    type: 'roomCreated',
    roomId,
    quizId,
    quizTitle: meta.title,
    questionCount: meta.questionCount,
  });
  await broadcastState(ctx.domainName, ctx.stage, roomId);
}

async function handleJoinRoom(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<void> {
  const validated = validateJoinInput(body);
  if (!validated.ok) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, validated.error);
    return;
  }
  const { name, roomId } = validated;

  const room = await getRoom(roomId);
  if (!room) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'room not found');
    return;
  }
  if (room.phase !== 'lobby') {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'game already started');
    return;
  }

  // Reject a duplicate display name already taken in this room.
  const existingPlayer = await ddb.send(
    new GetCommand({
      TableName: tableName(),
      Key: { pk: roomPk(roomId), sk: playerSk(name) },
    }),
  );
  if (existingPlayer.Item) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'name already taken in this room');
    return;
  }

  const ttl = ttlEpoch();
  const connItem: ConnItem = {
    pk: roomPk(roomId),
    sk: connSk(ctx.connectionId),
    type: 'CONN',
    connectionId: ctx.connectionId,
    name,
    role: 'player',
    ttl,
  };
  const lookup: ConnLookupItem = {
    pk: connLookupPk(ctx.connectionId),
    sk: 'META',
    type: 'CONN_LOOKUP',
    roomId,
    name,
    role: 'player',
    ttl,
  };
  const player: PlayerItem = {
    pk: roomPk(roomId),
    sk: playerSk(name),
    type: 'PLAYER',
    name,
    score: 0,
    answeredForQuestion: -1,
    ttl,
  };

  await Promise.all([
    ddb.send(new PutCommand({ TableName: tableName(), Item: connItem })),
    ddb.send(new PutCommand({ TableName: tableName(), Item: lookup })),
    ddb.send(new PutCommand({ TableName: tableName(), Item: player })),
  ]);

  const client = mgmtClient(ctx.domainName, ctx.stage);
  await postToConnection(client, roomId, ctx.connectionId, {
    type: 'joined',
    roomId,
    name,
    quizTitle: room.quizTitle,
    questionCount: room.questionCount,
  });
  await broadcastState(ctx.domainName, ctx.stage, roomId);
}

/** Shared guard for host-only control actions. Returns the room or null. */
async function requireHostForRoom(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<RoomMetaItem | null> {
  const hostSub = await verifyHostToken(body.token);
  if (!hostSub) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'unauthorized: valid host token required');
    return null;
  }
  const roomId = typeof body.roomId === 'string' ? body.roomId : undefined;
  if (!roomId) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'roomId is required');
    return null;
  }
  const room = await getRoom(roomId);
  if (!room) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'room not found');
    return null;
  }
  if (room.hostSub !== hostSub) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'forbidden: not the room host');
    return null;
  }
  return room;
}

async function handleStartGame(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<void> {
  const room = await requireHostForRoom(ctx, body);
  if (!room) {
    return;
  }
  if (room.phase !== 'lobby') {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'game already started');
    return;
  }
  const phase = nextGamePhase('lobby', room.questionCount, -1);
  const currentQuestion = phase === 'in_question' ? 0 : room.currentQuestion;
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: room.pk, sk: 'META' },
      UpdateExpression: 'SET phase = :phase, currentQuestion = :cq',
      ExpressionAttributeValues: { ':phase': phase, ':cq': currentQuestion },
    }),
  );
  await broadcastState(ctx.domainName, ctx.stage, room.roomId);
}

async function handleNextQuestion(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<void> {
  const room = await requireHostForRoom(ctx, body);
  if (!room) {
    return;
  }
  if (room.phase === 'finished' || room.phase === 'lobby') {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'cannot advance from the current phase');
    return;
  }

  // From in_question -> between (reveal); from between -> next question or
  // finished. This lets the host both reveal the current answer and move on.
  const phase = nextGamePhase(room.phase, room.questionCount, room.currentQuestion);
  let currentQuestion = room.currentQuestion;
  if (room.phase === 'between' && phase === 'in_question') {
    currentQuestion = room.currentQuestion + 1;
  }

  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: room.pk, sk: 'META' },
      UpdateExpression: 'SET phase = :phase, currentQuestion = :cq',
      ExpressionAttributeValues: { ':phase': phase, ':cq': currentQuestion },
    }),
  );
  await broadcastState(ctx.domainName, ctx.stage, room.roomId);
}

async function handleEndGame(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<void> {
  const room = await requireHostForRoom(ctx, body);
  if (!room) {
    return;
  }
  await ddb.send(
    new UpdateCommand({
      TableName: tableName(),
      Key: { pk: room.pk, sk: 'META' },
      UpdateExpression: 'SET phase = :phase',
      ExpressionAttributeValues: { ':phase': 'finished' as GamePhase },
    }),
  );
  await broadcastState(ctx.domainName, ctx.stage, room.roomId);
}

async function handleSubmitAnswer(
  ctx: ActionCtx,
  body: Record<string, unknown>,
): Promise<void> {
  // Participant action: no token required. Identify the player by the
  // connection lookup so a client cannot score for another name.
  const lookup = await getConnLookup(ctx.connectionId);
  if (!lookup || lookup.role !== 'player') {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'not a participant in a room');
    return;
  }
  const roomId = lookup.roomId;
  const room = await getRoom(roomId);
  if (!room) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'room not found');
    return;
  }
  if (room.phase !== 'in_question') {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'not accepting answers right now');
    return;
  }

  const submittedIndex = body.answerIndex;
  if (typeof submittedIndex !== 'number' || !Number.isInteger(submittedIndex)) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'answerIndex must be an integer');
    return;
  }

  const questionIndex = room.currentQuestion;

  // Load the stored question and score server-side using its answerIndex.
  const { questions } = await getQuizQuestions(room.quizId);
  const question = questions[questionIndex];
  if (!question) {
    await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'question not available');
    return;
  }
  const correct = scoreSingleAnswer(question.answerIndex, submittedIndex);

  // Increment score only when correct, and ONLY once per question
  // (answeredForQuestion guard prevents duplicate submissions).
  try {
    await ddb.send(
      new UpdateCommand({
        TableName: tableName(),
        Key: { pk: roomPk(roomId), sk: playerSk(lookup.name) },
        UpdateExpression:
          'SET answeredForQuestion = :q, score = score + :inc',
        ConditionExpression:
          'attribute_not_exists(answeredForQuestion) OR answeredForQuestion < :q',
        ExpressionAttributeValues: {
          ':q': questionIndex,
          ':inc': correct ? 1 : 0,
        },
      }),
    );
  } catch (err) {
    // ConditionalCheckFailedException => duplicate submission for this
    // question; ignore silently (idempotent).
    if ((err as { name?: string }).name !== 'ConditionalCheckFailedException') {
      throw err;
    }
    return;
  }

  // Acknowledge to the submitter WITHOUT revealing the correct answerIndex.
  const client = mgmtClient(ctx.domainName, ctx.stage);
  await postToConnection(client, roomId, ctx.connectionId, {
    type: 'answerAck',
    n: questionIndex,
    correct,
  });
  // Live scoreboard update to the whole room.
  await broadcastState(ctx.domainName, ctx.stage, roomId);
}

async function handleDisconnect(ctx: ActionCtx): Promise<void> {
  const lookup = await getConnLookup(ctx.connectionId);
  if (!lookup) {
    return;
  }
  await removeConnection(lookup.roomId, ctx.connectionId);

  if (lookup.role === 'host') {
    // Host left: mark the room finished so participants see the game ended.
    const room = await getRoom(lookup.roomId);
    if (room && room.phase !== 'finished') {
      await ddb.send(
        new UpdateCommand({
          TableName: tableName(),
          Key: { pk: room.pk, sk: 'META' },
          UpdateExpression: 'SET phase = :phase',
          ExpressionAttributeValues: { ':phase': 'finished' as GamePhase },
        }),
      );
    }
  }
  // Refresh remaining participants' scoreboard/state.
  await broadcastState(ctx.domainName, ctx.stage, lookup.roomId);
}

// --- Entry point ------------------------------------------------------------

export const handler = async (
  event: APIGatewayProxyWebsocketEventV2,
): Promise<{ statusCode: number; body?: string }> => {
  const { connectionId, routeKey, domainName, stage } = event.requestContext;
  const ctx: ActionCtx = {
    connectionId: connectionId ?? '',
    domainName: domainName ?? '',
    stage: stage ?? '',
  };

  try {
    if (routeKey === '$connect') {
      // Allow ALL connections (participants have no token). Room membership
      // is established later via createRoom/joinRoom.
      return { statusCode: 200 };
    }
    if (routeKey === '$disconnect') {
      await handleDisconnect(ctx);
      return { statusCode: 200 };
    }

    let body: Record<string, unknown> = {};
    if (event.body) {
      try {
        const parsed = JSON.parse(event.body);
        if (parsed && typeof parsed === 'object') {
          body = parsed as Record<string, unknown>;
        }
      } catch {
        await sendError(ctx.domainName, ctx.stage, ctx.connectionId, 'invalid JSON body');
        return { statusCode: 400 };
      }
    }

    // The route key is the custom action name for custom routes, or
    // '$default' when the body's action does not match a defined route.
    const action =
      routeKey && routeKey !== '$default'
        ? routeKey
        : typeof body.action === 'string'
          ? body.action
          : undefined;

    switch (action) {
      case 'createRoom':
        await handleCreateRoom(ctx, body);
        break;
      case 'joinRoom':
        await handleJoinRoom(ctx, body);
        break;
      case 'startGame':
        await handleStartGame(ctx, body);
        break;
      case 'submitAnswer':
        await handleSubmitAnswer(ctx, body);
        break;
      case 'nextQuestion':
        await handleNextQuestion(ctx, body);
        break;
      case 'endGame':
        await handleEndGame(ctx, body);
        break;
      default:
        await sendError(ctx.domainName, ctx.stage, ctx.connectionId, `unknown action: ${String(action)}`);
        break;
    }

    return { statusCode: 200 };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('ws handler error', err);
    return { statusCode: 500 };
  }
};
