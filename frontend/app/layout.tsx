import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'AP1000 · Protection Lab', description: 'Educational reactor protection logic simulator. Not qualified for plant operation.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ko"><body>{children}</body></html>; }
