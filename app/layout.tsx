import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { LocaleProvider } from '@/components/locale-provider';
import { ShaderBackground } from '@/components/shader-background';

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
  title: 'Larpscan',
  description:
    'Empirically verify crypto project claims with browser-run evidence and deterministic verdicts.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="font-sans text-white antialiased">
        <ShaderBackground />
        <LocaleProvider>{children}</LocaleProvider>
      </body>
    </html>
  );
}
