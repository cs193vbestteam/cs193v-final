import type { Metadata } from "next";
import Link from "next/link";
import { logoutAction } from "./actions";
import { currentUser } from "@/lib/session";
import "./globals.css";

export const metadata: Metadata = {
  title: "Tacit — group plans without the group-chat drama",
  description: "Tell your own assistant your real constraints in private. The assistants find a plan that works for everyone.",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            tacit<span className="text-accent">.</span>
          </Link>
          {user ? (
            <form action={logoutAction} className="flex items-center gap-3 text-sm">
              <span className="text-muted">Hi, {user.displayName}</span>
              <button className="btn-ghost py-1">Log out</button>
            </form>
          ) : (
            <nav className="flex gap-2 text-sm">
              <Link href="/login" className="btn-ghost py-1">Log in</Link>
              <Link href="/signup" className="btn py-1">Sign up</Link>
            </nav>
          )}
        </header>
        <main className="mx-auto max-w-5xl px-4 pb-16">{children}</main>
      </body>
    </html>
  );
}
