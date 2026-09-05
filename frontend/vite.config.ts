import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite の設定。root は既定で frontend/、出力は frontend/dist。
// import.meta.env.VITE_* に注入された値をクライアントから参照する。
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
});
