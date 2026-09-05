import React from 'react';
import { createRoot } from 'react-dom/client';
import HomePage from './pages/HomePage';
import './styles.css';

// 公開アプリ（index.html）のエントリ。<HomePage/> を #root にマウントする。
// ルーターは使わず、管理者ページへは admin.html への通常リンクで遷移する。
const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}

createRoot(container).render(
  <React.StrictMode>
    <HomePage />
  </React.StrictMode>,
);
