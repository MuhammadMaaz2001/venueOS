import localFont from 'next/font/local';

// Self-hosted (src/fonts/NOTICE.md): no Google Fonts download at build or run time. English only; a language
// with another script adds its font here and in globals.css (--font-sans).
export const latinFont = localFont({
  src: [
    { path: '../fonts/noto-sans-latin-400-normal.woff2', weight: '400', style: 'normal' },
    { path: '../fonts/noto-sans-latin-700-normal.woff2', weight: '700', style: 'normal' },
  ],
  variable: '--font-latin',
  display: 'swap',
});
