import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "CrossDock Dashboard",
  description: "Live status of the CrossDock file sync, editor tunnel and iOS deployment pipeline.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
