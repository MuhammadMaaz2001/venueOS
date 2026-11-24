import localFont from 'next/font/local';

// Self-hosted (src/fonts/NOTICE.md): no Google Fonts download at build or run time.
export const latinFont = localFont({
  src: [
    { path: '../fonts/noto-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/noto-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-latin',
  display: 'swap',
});

// Naskh for the Urdu UI: Nastaliq is too tall for dense controls and tables.
export const urduFont = localFont({
  src: [
    { path: '../fonts/noto-naskh-arabic-arabic-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/noto-naskh-arabic-arabic-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-urdu',
  display: 'swap',
});
