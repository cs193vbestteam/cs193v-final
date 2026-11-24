import type { Metadata, Viewport } from "next";
import { Instrument_Sans, Instrument_Serif, JetBrains_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { logoutAction } from "./actions";
import { AuthNav } from "@/components/AuthNav";
import { Avatar } from "@/components/Avatar";
import { PointerEffects } from "@/components/Effects";
import { Wordmark } from "@/components/Wordmark";
import { avatarFor } from "@/lib/avatar";
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
  title: "Settle — your group chat is stuck. Settle it.",
  description:
    "Tell your own assistant your real constraints in private. Settle picks a place and a time that fit the group, and nobody's numbers are shown to anyone.",
};

export const viewport: Viewport = {
  themeColor: "#f3eee4",
  width: "device-width",
  initialScale: 1,
};

/** Shown while the client nav reads the URL: the same links, without a `next`. */
function AuthNavFallback() {
  return (
    <nav className="flex items-center gap-2">
      <Link href="/login" className="btn-ghost btn-sm">
        Log in
      </Link>
      <Link href="/signup" className="btn btn-sm">
        Sign up
      </Link>
    </nav>
  );
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en" data-scroll-behavior="smooth" className={`${serif.variable} ${sans.variable} ${mono.variable}`}>
      <body className="flex min-h-dvh flex-col">
        <PointerEffects />
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="sticky top-0 z-40 border-b border-line/0 bg-paper/70 backdrop-blur-md">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
            <Wordmark />
            {user ? (
              <form action={logoutAction} className="flex items-center gap-4">
                <span className="hidden text-sm text-ink-2 sm:inline">
                  {user.guest ? "Here as a guest:" : "Signed in as"}{" "}
                  <span className="font-medium text-ink">{user.displayName}</span>
                </span>
                <Link href="/account" className="flex items-center gap-2 text-sm text-ink-2">
                  <Avatar name={avatarFor(user.id)} size={24} />
                  <span className="link">Account</span>
                </Link>
                {/* A guest has nothing to log back in with, so logging out would strand what they said. */}
                {user.guest ? (
                  <Link href="/signup" className="btn-ghost btn-sm">
                    Save account
                  </Link>
                ) : (
                  <button className="btn-ghost btn-sm">Log out</button>
                )}
              </form>
            ) : (
              <Suspense fallback={<AuthNavFallback />}>
                <AuthNav />
              </Suspense>
            )}
          </div>
        </header>
        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 px-5 pb-20 outline-none sm:px-8">
          {children}
        </main>
        <footer className="mx-auto w-full max-w-6xl px-5 pb-8 sm:px-8">
          <div className="flex flex-col gap-2 border-t border-line pt-5 text-xs text-ink-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="font-mono tracking-wider">SETTLE · PRIVATE LIMITS, SHARED PLANS</span>
            <span>
              Constraints encrypted at rest · the group sees only the plan ·{" "}
              <Link href="/privacy" className="link link-small">
                Privacy
              </Link>
            </span>
          </div>
        </footer>
      </body>
    </html>
  );
}
