import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'in.thecontrarian.manorama',
  appName: 'Manorama',
  webDir: 'native/dist',
  backgroundColor: '#0a0a0a',
  ios: {
    contentInset: 'never',
    scrollEnabled: true,
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0a0a0a',
  },
  plugins: {
    StatusBar: {
      // The WebView paints under the status bar. With `overlaysWebView: false`
      // the native root background — `backgroundColor` above — showed through
      // as a black band above every surface whose own canvas is lighter, the
      // opening screen's #111312 most visibly. Overlaying hands the whole
      // screen to the page, which already carries `env(safe-area-inset-top)`
      // as body padding and so keeps its content clear of the notch.
      overlaysWebView: true,
      style: 'DARK',
      backgroundColor: '#0a0a0a',
    },
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 350,
      backgroundColor: '#0a0a0a',
      showSpinner: false,
      splashFullScreen: false,
      splashImmersive: false,
    },
  },
};

export default config;
