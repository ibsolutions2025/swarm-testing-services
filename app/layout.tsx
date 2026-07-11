import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarm Testing Services",
  description:
    "Turn a product URL and documentation into a risk-based, reviewable test plan. Now in private beta.",
  openGraph: {
    title: "Swarm Testing Services",
    description:
      "Source-backed product discovery and swarm test planning, now in private beta.",
    type: "website"
  }
};

export default function RootLayout({
  children
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  );
}
