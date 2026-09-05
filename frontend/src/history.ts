// クイズ履歴モジュール（クライアント側・ログイン不要）。
//
// 採点結果をブラウザの localStorage に単一のバージョン付きエンベロープで保存し、
// 履歴の読み込み・追記・クリア・集計を行う純粋関数を公開する。バックエンドは変更しない。
//
// 設計方針:
//   - すべての localStorage アクセス（getItem/setItem/removeItem）は try/catch で保護し、
//     プライベートモードや無効化された環境でも例外を投げず空履歴に degrade する。
//   - レコードは MAX_RECORDS 件を上限とし、古いものから捨てて無制限な増加を防ぐ。
//   - React には依存せず、import 時に副作用を持たない（純粋関数のみ）。

/** 1 回の採点結果を表す履歴レコード。 */
export interface HistoryRecord {
  /** クイズ ID。 */
  quizId: string;
  /** クイズのタイトル（表示用）。 */
  title: string;
  /** 正解数。 */
  score: number;
  /** 設問数。 */
  total: number;
  /** 正答率（%）。total が 0 のときは 0。round(score/total*100)。 */
  percent: number;
  /** 受験日時（ISO 8601 タイムスタンプ）。 */
  takenAt: string;
}

/** localStorage に保存するバージョン付きエンベロープ。 */
interface HistoryStore {
  version: number;
  records: HistoryRecord[];
}

/** 履歴を保存する localStorage のキー。 */
export const STORAGE_KEY = 'quizHistory';

/** 現在のエンベロープバージョン。 */
export const CURRENT_VERSION = 1;

/** 保持する履歴レコードの最大件数。 */
export const MAX_RECORDS = 200;

/** 値が well-formed な HistoryRecord かどうかを型ガードで検証する。 */
function isHistoryRecord(value: unknown): value is HistoryRecord {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r.quizId === 'string' &&
    typeof r.title === 'string' &&
    typeof r.score === 'number' &&
    typeof r.total === 'number' &&
    typeof r.percent === 'number' &&
    typeof r.takenAt === 'string'
  );
}

/**
 * localStorage から履歴を読み込む。キー不在・不正な JSON・想定外の形状・
 * バージョン不一致のいずれの場合も [] を返す。決して例外を投げない。
 * 破損したレコードは除外され、正常なもののみ返す。
 */
export function load(): HistoryRecord[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') {
      return [];
    }
    const store = parsed as Record<string, unknown>;
    if (store.version !== CURRENT_VERSION) {
      return [];
    }
    if (!Array.isArray(store.records)) {
      return [];
    }
    return store.records.filter(isHistoryRecord);
  } catch {
    return [];
  }
}

/**
 * 履歴に新しいレコードを追記する。現在の履歴を読み込み、末尾に追加し、
 * 最新の MAX_RECORDS 件に切り詰めて localStorage に書き戻す。書き込みが失敗
 * （容量超過・無効化）してもエラーは握りつぶし、切り詰め後の配列を返すので
 * 呼び出し元／UI は処理を続行できる。
 */
export function append(record: HistoryRecord): HistoryRecord[] {
  const records = load();
  records.push(record);
  const trimmed =
    records.length > MAX_RECORDS ? records.slice(-MAX_RECORDS) : records;
  try {
    const store: HistoryStore = {
      version: CURRENT_VERSION,
      records: trimmed,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // 書き込み失敗（容量超過・無効化など）は無視し、メモリ上の配列を返す。
  }
  return trimmed;
}

/**
 * 履歴レコードを生成する便利ファクトリ。percent は
 * total > 0 ? Math.round((score/total)*100) : 0 で計算し（HomePage の既存式と一致）、
 * takenAt は未指定なら new Date().toISOString() を既定値とする。
 */
export function makeRecord(input: {
  quizId: string;
  title: string;
  score: number;
  total: number;
  takenAt?: string;
}): HistoryRecord {
  const { quizId, title, score, total } = input;
  const percent = total > 0 ? Math.round((score / total) * 100) : 0;
  return {
    quizId,
    title,
    score,
    total,
    percent,
    takenAt: input.takenAt ?? new Date().toISOString(),
  };
}

/** 履歴を全消去する（localStorage からキーを削除）。決して例外を投げない。 */
export function clear(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 削除失敗は無視する。
  }
}

/**
 * クイズ ID ごとに集計する。percent の平均を整数に丸め、受験回数を数え、
 * 表示用タイトルには最新レコードのものを用いる。棒グラフ向けに、タイトルの
 * 昇順で安定した順序の配列を返す。
 */
export function averageByQuiz(
  records: HistoryRecord[],
): Array<{
  quizId: string;
  title: string;
  averagePercent: number;
  attempts: number;
}> {
  const groups = new Map<
    string,
    { title: string; latestAt: string; sum: number; attempts: number }
  >();

  for (const record of records) {
    const existing = groups.get(record.quizId);
    if (existing === undefined) {
      groups.set(record.quizId, {
        title: record.title,
        latestAt: record.takenAt,
        sum: record.percent,
        attempts: 1,
      });
    } else {
      existing.sum += record.percent;
      existing.attempts += 1;
      // 最新レコードのタイトルを表示に採用する。
      if (record.takenAt >= existing.latestAt) {
        existing.latestAt = record.takenAt;
        existing.title = record.title;
      }
    }
  }

  const result = Array.from(groups.entries()).map(([quizId, group]) => ({
    quizId,
    title: group.title,
    averagePercent: Math.round(group.sum / group.attempts),
    attempts: group.attempts,
  }));

  result.sort((a, b) => a.title.localeCompare(b.title));
  return result;
}

/**
 * takenAt の昇順にソートしたコピーを返す（入力は変更しない）。
 * 時系列の折れ線グラフ向け。
 */
export function chronological(records: HistoryRecord[]): HistoryRecord[] {
  return [...records].sort((a, b) => a.takenAt.localeCompare(b.takenAt));
}
