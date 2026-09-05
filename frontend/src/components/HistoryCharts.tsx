// 依存関係ゼロの自前インライン SVG チャートコンポーネント群。
//
// チャートライブラリは一切追加せず、React 要素として <svg> を直接描画する。
// レスポンシブ対応は viewBox で行い（CSS で width:100% / height:auto）、配色は
// ハードコードした 16 進数を使わず既存の CSS 変数（var(--primary) など）と
// currentColor に委ねるため、ライト / ダークの両モードで読める。
//
// アクセシビリティ:
//   - ルート <svg> に role="img" と aria-label を付与し、<title> も入れる。
//   - 色だけに依存しない: 軸の端点（0 / 100）や各点・棒の数値、クイズ名を
//     テキストとして描画する。

import type { HistoryRecord } from '../history';

// ---- 折れ線グラフ（スコア推移） -----------------------------------------

/** viewBox の座標系（論理ピクセル）。実表示幅は CSS の width:100% に従う。 */
const LINE_VIEW_W = 640;
const LINE_VIEW_H = 320;
const LINE_PAD_L = 44;
const LINE_PAD_R = 16;
const LINE_PAD_T = 20;
const LINE_PAD_B = 44;

const PLOT_L = LINE_PAD_L;
const PLOT_R = LINE_VIEW_W - LINE_PAD_R;
const PLOT_T = LINE_PAD_T;
const PLOT_B = LINE_VIEW_H - LINE_PAD_B;
const PLOT_W = PLOT_R - PLOT_L;
const PLOT_H = PLOT_B - PLOT_T;

/** percent(0-100) を y 座標に変換する。 */
function percentToY(percent: number): number {
  const clamped = percent < 0 ? 0 : percent > 100 ? 100 : percent;
  return PLOT_B - (clamped / 100) * PLOT_H;
}

/** i 番目（0 始まり）の点の x 座標を返す。点が 1 個のときは中央に置く。 */
function indexToX(i: number, count: number): number {
  if (count <= 1) {
    return PLOT_L + PLOT_W / 2;
  }
  return PLOT_L + (i / (count - 1)) * PLOT_W;
}

/** takenAt(ISO) を短い日本語日付ラベルにする（日付ライブラリは使わない）。 */
function shortDateLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    return '';
  }
  return d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

/**
 * スコア推移の折れ線グラフ。x 軸は受験順（時系列）、y 軸は正答率（0〜100）。
 * records は時系列昇順で渡されることを想定する（history.chronological）。
 */
export function LineChart({ records }: { records: HistoryRecord[] }) {
  const count = records.length;
  const gridPercents = [0, 25, 50, 75, 100];

  const points = records.map((r, i) => ({
    x: indexToX(i, count),
    y: percentToY(r.percent),
    percent: r.percent,
    label: shortDateLabel(r.takenAt),
  }));

  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');

  const label =
    `スコア推移の折れ線グラフ。受験ごとの正答率（0〜100%）を時系列で表示。` +
    `全 ${count} 件。`;

  return (
    <svg
      className="svg-chart"
      viewBox={`0 0 ${LINE_VIEW_W} ${LINE_VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>

      {/* 水平グリッド線と y 軸の目盛りラベル（0 と 100 を必ず明示）。 */}
      {gridPercents.map((p) => {
        const y = percentToY(p);
        return (
          <g key={p}>
            <line
              className="chart-grid"
              x1={PLOT_L}
              y1={y}
              x2={PLOT_R}
              y2={y}
            />
            <text
              className="chart-axis-label"
              x={PLOT_L - 8}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {p}
            </text>
          </g>
        );
      })}

      {/* y 軸・x 軸の線。 */}
      <line
        className="chart-axis"
        x1={PLOT_L}
        y1={PLOT_T}
        x2={PLOT_L}
        y2={PLOT_B}
      />
      <line
        className="chart-axis"
        x1={PLOT_L}
        y1={PLOT_B}
        x2={PLOT_R}
        y2={PLOT_B}
      />

      {/* 折れ線（点が 2 個以上のとき）。 */}
      {count >= 2 && (
        <polyline className="chart-line" points={polyline} fill="none" />
      )}

      {/* 各点のマーカーと値ラベル。 */}
      {points.map((p, i) => (
        <g key={i}>
          <circle className="chart-point" cx={p.x} cy={p.y} r={4} />
          <text
            className="chart-value-label"
            x={p.x}
            y={p.y - 10}
            textAnchor="middle"
          >
            {p.percent}%
          </text>
          {p.label !== '' && (
            <text
              className="chart-axis-label"
              x={p.x}
              y={PLOT_B + 18}
              textAnchor="middle"
            >
              {p.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

// ---- 棒グラフ（クイズ別平均正答率） -------------------------------------

const BAR_VIEW_W = 640;
const BAR_VIEW_H = 340;
const BAR_PAD_L = 44;
const BAR_PAD_R = 16;
const BAR_PAD_T = 20;
const BAR_PAD_B = 76;

const BAR_PLOT_L = BAR_PAD_L;
const BAR_PLOT_R = BAR_VIEW_W - BAR_PAD_R;
const BAR_PLOT_T = BAR_PAD_T;
const BAR_PLOT_B = BAR_VIEW_H - BAR_PAD_B;
const BAR_PLOT_W = BAR_PLOT_R - BAR_PLOT_L;
const BAR_PLOT_H = BAR_PLOT_B - BAR_PLOT_T;

/** 長いクイズ名を x 軸ラベル用に切り詰める。 */
function truncateLabel(title: string, max = 8): string {
  return title.length > max ? title.slice(0, max) + '…' : title;
}

/** クイズ別平均正答率の集計（history.averageByQuiz の戻り値）。 */
export interface QuizAverage {
  quizId: string;
  title: string;
  averagePercent: number;
  attempts: number;
}

/**
 * クイズ別平均正答率の棒グラフ。1 クイズにつき 1 本の棒（0〜100%）。
 * 棒の幅・間隔はデータ件数から計算するのでスケールする。
 */
export function BarChart({ data }: { data: QuizAverage[] }) {
  const count = data.length;
  const gridPercents = [0, 25, 50, 75, 100];

  // 各クイズに割り当てる横幅の 1 スロット、その 62% を棒の幅にする。
  const slot = count > 0 ? BAR_PLOT_W / count : BAR_PLOT_W;
  const barWidth = slot * 0.62;

  function percentToBarY(percent: number): number {
    const clamped = percent < 0 ? 0 : percent > 100 ? 100 : percent;
    return BAR_PLOT_B - (clamped / 100) * BAR_PLOT_H;
  }

  const label =
    `クイズ別の平均正答率を示す棒グラフ。各クイズの平均正答率（0〜100%）を表示。` +
    `全 ${count} 件。`;

  return (
    <svg
      className="svg-chart"
      viewBox={`0 0 ${BAR_VIEW_W} ${BAR_VIEW_H}`}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={label}
    >
      <title>{label}</title>

      {/* 水平グリッド線と y 軸ラベル。 */}
      {gridPercents.map((p) => {
        const y = percentToBarY(p);
        return (
          <g key={p}>
            <line
              className="chart-grid"
              x1={BAR_PLOT_L}
              y1={y}
              x2={BAR_PLOT_R}
              y2={y}
            />
            <text
              className="chart-axis-label"
              x={BAR_PLOT_L - 8}
              y={y}
              textAnchor="end"
              dominantBaseline="middle"
            >
              {p}
            </text>
          </g>
        );
      })}

      {/* y 軸・x 軸の線。 */}
      <line
        className="chart-axis"
        x1={BAR_PLOT_L}
        y1={BAR_PLOT_T}
        x2={BAR_PLOT_L}
        y2={BAR_PLOT_B}
      />
      <line
        className="chart-axis"
        x1={BAR_PLOT_L}
        y1={BAR_PLOT_B}
        x2={BAR_PLOT_R}
        y2={BAR_PLOT_B}
      />

      {/* 各クイズの棒・値ラベル・x 軸ラベル。 */}
      {data.map((d, i) => {
        const slotStart = BAR_PLOT_L + i * slot;
        const x = slotStart + (slot - barWidth) / 2;
        const y = percentToBarY(d.averagePercent);
        const h = BAR_PLOT_B - y;
        const cx = x + barWidth / 2;
        return (
          <g key={d.quizId}>
            <rect
              className="chart-bar"
              x={x}
              y={y}
              width={barWidth}
              height={h}
              rx={3}
            />
            <text
              className="chart-value-label"
              x={cx}
              y={y - 6}
              textAnchor="middle"
            >
              {d.averagePercent}%
            </text>
            <text
              className="chart-axis-label"
              x={cx}
              y={BAR_PLOT_B + 18}
              textAnchor="middle"
            >
              {truncateLabel(d.title)}
            </text>
            <text
              className="chart-axis-sub"
              x={cx}
              y={BAR_PLOT_B + 34}
              textAnchor="middle"
            >
              {d.attempts}回
            </text>
          </g>
        );
      })}
    </svg>
  );
}
