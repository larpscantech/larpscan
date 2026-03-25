import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { LocaleProvider } from '@/components/locale-provider';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LARPSCAN — Verification for Crypto Products',
  description:
    'Empirically verify crypto project claims with browser-run evidence and deterministic verdicts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans bg-cv-bg text-white antialiased">
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
