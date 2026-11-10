import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { logoutAction } from "./actions";
import { Wordmark } from "@/components/Wordmark";
import { currentUser } from "@/lib/session";
import "./globals.css";

const serif = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-instrument-serif",
  display: "swap",
});
const sans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Tacit — group plans without the group chat",
  description:
    "Tell your own assistant your real constraints in private. The assistants negotiate a plan that works for everyone, and nobody's numbers leave the room.",
};

export const viewport: Viewport = {
  themeColor: "#f3eee4",
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <header className="sticky top-0 z-40 border-b border-line/0 bg-paper/70 backdrop-blur-md">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
            <Wordmark />
            {user ? (
              <form action={logoutAction} className="flex items-center gap-4">
                <span className="hidden text-sm text-ink-2 sm:inline">
                  Signed in as <span className="font-medium text-ink">{user.displayName}</span>
                </span>
                <button className="btn-ghost btn-sm">Log out</button>
              </form>
            ) : (
              <nav className="flex items-center gap-2">
                <Link href="/login" className="btn-ghost btn-sm">
                  Log in
                </Link>
                <Link href="/signup" className="btn btn-sm">
                  Sign up
                </Link>
              </nav>
            )}
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-5 pb-20 sm:px-8">{children}</main>
        <footer className="mx-auto w-full max-w-6xl px-5 pb-8 sm:px-8">
          <div className="flex flex-col gap-2 border-t border-line pt-5 text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-mono tracking-wider">TACIT · PRIVATE BY CONSTRUCTION</span>
            <span>Constraints encrypted at rest · only verdicts leave your assistant</span>
          </div>
        </footer>
      </body>
    </html>
  );
}
