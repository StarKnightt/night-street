import type { Metadata } from 'next';
import './globals.css';

/* No `next/font/google`. It downloads a font file at build time, and this
 * project ships zero external assets — the small amount of UI text uses the
 * platform stack. */

export const metadata: Metadata = {
  title: 'Night Street',
  description: 'A city side street at 11pm. Every surface generated in code.',
};

export const viewport = {
  themeColor: '#05070b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="h-full overflow-hidden bg-black text-white">{children}</body>
    </html>
  );
}
