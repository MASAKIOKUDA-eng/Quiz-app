import { Link } from 'react-router-dom';

// 管理者クイズ登録フローのプレースホルダー。リッチな UI は FEAT-002 で実装する。
export default function AdminPage() {
  return (
    <main className="app">
      <h1>管理者ページ</h1>
      <p className="status">クイズ登録フォームはこのページに表示されます。</p>
      <div className="home-link">
        <Link to="/">クイズアプリへ戻る</Link>
      </div>
    </main>
  );
}
