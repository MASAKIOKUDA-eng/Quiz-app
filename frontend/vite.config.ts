import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Vite の設定。root は既定で frontend/、出力は frontend/dist。
// マルチページ構成: index.html（公開アプリ）と admin.html（管理者アプリ）の
// 2 つの HTML エントリを Vite ルート直下に置く。admin ページを実体のある
// 静的ファイル /admin.html として配信することで、Cognito Hosted UI の
// コールバック/ログアウト URL（CDK が <baseUrl>/admin.html を登録済み）と
// redirect_uri が完全一致する。SPA の書き換えルールも不要。
// import.meta.env.VITE_* に注入された値をクライアントから参照する。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        admin: resolve(__dirname, 'admin.html'),
      },
    },
  },
});
