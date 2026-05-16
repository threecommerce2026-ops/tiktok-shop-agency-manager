import type { Metadata, Viewport } from "next";
import { Outfit } from "next/font/google";
import "./globals.css";

const outfit = Outfit({
  variable: "--font-outfit",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "TikTok Shop Agency Manager",
    template: "%s | TSAM",
  },
  description:
    "TikTok Shop 代理店向け。紹介クリエイターの売上・収益・分配率に基づく代理店報酬を月次管理。",
  applicationName: "TikTok Shop Agency Manager",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#030306",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className={`${outfit.variable} dark h-full`}>
      <body className="min-h-full flex flex-col bg-surface-0 antialiased">
        {children}
      </body>
    </html>
  );
}
