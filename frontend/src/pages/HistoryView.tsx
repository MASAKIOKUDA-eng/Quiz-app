// クイズ履歴の表示画面（クライアント側・ログイン不要）。
//
// localStorage に保存された履歴（FEAT-001 の history モジュール）を読み込み、
// スコア推移の折れ線グラフ・クイズ別平均正答率の棒グラフ・直近の受験一覧を表示する。
// 履歴の消去は window.confirm で確認してから行う。バックエンドには一切アクセスしない。

import { useState } from 'react';
import { load, clear, chronological, averageByQuiz } from '../history';
import type { HistoryRecord } from '../history';
import { LineChart, BarChart } from '../components/HistoryCharts';

/** ISO タイムスタンプを日本語の日時表記に整形する（日付ライブラリは使わない）。 */
function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return iso;
  }
  return d.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// 直近の受験一覧に表示する最大件数。
const RECENT_LIMIT = 20;

/**
 * 履歴画面。onBack で一覧へ戻る。履歴が無ければ空状態を表示する。
 */
export default function HistoryView({ onBack }: { onBack: () => void }) {
  const [records, setRecords] = useState<HistoryRecord[]>(() => load());

  function handleClear(): void {
    const ok = window.confirm(
      '保存された履歴をすべて消去します。よろしいですか？（この操作は元に戻せません）',
    );
    if (!ok) {
      return;
    }
    clear();
    setRecords([]);
  }

  if (records.length === 0) {
    return (
      <section className="history-view">
        <h2 className="quiz-heading">履歴</h2>
        <p className="empty-state">
          まだ履歴がありません。クイズに回答すると、ここに結果が記録されます。
        </p>
        <div className="quiz-actions">
          <button type="button" className="btn" onClick={onBack}>
            一覧に戻る
          </button>
        </div>
      </section>
    );
  }

  const timeline = chronological(records);
  const averages = averageByQuiz(records);
  // 新しい順（受験日時の降順）に直近の受験を並べる。
  const recent = [...timeline].reverse().slice(0, RECENT_LIMIT);

  return (
    <section className="history-view">
      <h2 className="quiz-heading">履歴</h2>

      <div className="card history-chart-card">
        <h3 className="history-chart-title">スコア推移</h3>
        <LineChart records={timeline} />
      </div>

      <div className="card history-chart-card">
        <h3 className="history-chart-title">クイズ別の平均正答率</h3>
        <BarChart data={averages} />
      </div>

      <div className="card history-recent-card">
        <h3 className="history-chart-title">直近の受験</h3>
        <ul className="history-recent-list">
          {recent.map((r, i) => (
            <li className="history-recent-item" key={`${r.takenAt}-${i}`}>
              <span className="history-recent-title">{r.title}</span>
              <span className="history-recent-percent">{r.percent}%</span>
              <span className="history-recent-score">
                {r.score} / {r.total}
              </span>
              <span className="history-recent-date">
                {formatDateTime(r.takenAt)}
              </span>
            </li>
          ))}
        </ul>
      </div>

      <div className="quiz-actions">
        <button type="button" className="btn" onClick={onBack}>
          一覧に戻る
        </button>
        <button type="button" className="btn small" onClick={handleClear}>
          履歴を消去
        </button>
      </div>
    </section>
  );
}
