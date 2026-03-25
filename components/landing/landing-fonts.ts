import { Manrope, Syne } from 'next/font/google';

export const displayFont = Syne({
  subsets: ['latin'],
  weight: ['500', '700', '800'],
});

export const bodyFont = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
});
