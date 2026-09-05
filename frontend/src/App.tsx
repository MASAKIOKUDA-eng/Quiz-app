import { Routes, Route } from 'react-router-dom';
import HomePage from './pages/HomePage';
import AdminPage from './pages/AdminPage';

// アプリのルーティングシェル。
//   '/'      -> クイズ回答フロー（HomePage）
//   '/admin' -> 管理者クイズ登録フロー（AdminPage）
// リッチな UI は FEAT-002 で実装する。ここでは最小限のシェルのみ。
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/admin" element={<AdminPage />} />
    </Routes>
  );
}
