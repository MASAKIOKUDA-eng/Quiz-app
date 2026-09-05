import { Link } from 'react-router-dom';

// クイズ回答フローのプレースホルダー。リッチな UI は FEAT-002 で実装する。
export default function HomePage() {
  return (
    <main className="app">
      <h1>クイズアプリ</h1>
      <p className="status">クイズ一覧はこのページに表示されます。</p>
      <div className="home-link">
        <Link to="/admin">管理者ページへ</Link>
      </div>
    </main>
  );
}
