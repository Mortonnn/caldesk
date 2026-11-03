import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.caldesk.mobile',
  appName: 'caldesk',
  // 手机端专用构建产物（out/mobile），与桌面端完全分开
  webDir: 'out/mobile',
  server: {
    androidScheme: 'https'
  }
};

export default config;
