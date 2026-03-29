import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ふみきりアプリ",
  description: "リアルな日本の踏切シミュレーター",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
