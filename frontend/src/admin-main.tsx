import React from 'react';
import { createRoot } from 'react-dom/client';
import AdminPage from './pages/AdminPage';
import './styles.css';

// 管理者アプリ（admin.html）のエントリ。<AdminPage/> を #root にマウントする。
// このページは実体のある静的ファイル /admin.html として配信され、Cognito の
// redirect_uri（origin + '/admin.html'）が CDK 登録済み URL と一致する。
const container = document.getElementById('root');
if (!container) {
  throw new Error('root element not found');
}

createRoot(container).render(
  <React.StrictMode>
    <AdminPage />
  </React.StrictMode>,
);
