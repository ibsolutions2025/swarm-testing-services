import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Swarm Testing Services",
  description:
    "Stress-test your product with autonomous agent swarms. Zero bias, full coverage, human-readable results.",
  openGraph: {
    title: "Swarm Testing Services",
    description:
      "Stress-test your product with autonomous agent swarms.",
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
