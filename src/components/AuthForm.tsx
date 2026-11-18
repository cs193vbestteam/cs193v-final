"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/app/actions";

type Props = {
  mode: "login" | "signup";
  action: (state: FormState, form: FormData) => Promise<FormState>;
  next: string;
  /** Set when a guest is turning into an account: their name, which they keep unless they change it. */
  guestName?: string;
};

export function AuthForm({ mode, action, next, guestName }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const signup = mode === "signup";
  const joining = next.startsWith("/e/");
  const upgrading = guestName !== undefined;
  const code = joining ? next.slice(3).split(/[/?#]/)[0] : "";
  return (
    <div className="mx-auto mt-8 grid max-w-4xl items-start gap-10 sm:mt-16 lg:grid-cols-[1fr_minmax(0,24rem)]">
      <div className="rise max-w-md" style={{ "--d": "0s" } as React.CSSProperties}>
        <p className="eyebrow">
          {upgrading ? "Keep your plans" : joining ? "You're invited" : signup ? "New account" : "Welcome back"}
        </p>
        <h1 className="display mt-4 text-5xl sm:text-6xl">
          {signup ? (
            <>
              Your assistant, <em>your</em> secrets.
            </>
          ) : (
            <>
              Back to the <em>table.</em>
            </>
          )}
        </h1>
        <p className="lede mt-5">
          {upgrading
            ? "Add an email and a password. The plans you joined as a guest and your private chats stay with you, and you can open them from any device."
            : joining
              ? "You've been invited to a plan. Sign in and you'll get a private assistant. Tell it what actually works for you; nobody else will see it."
              : signup
                ? "One account, one private assistant per plan. What you tell it is encrypted and never shown to the group."
                : "Pick up where you left off. Your plans and private chats are waiting."}
        </p>
      </div>

      <div className="card rise" style={{ "--d": "0.12s" } as React.CSSProperties}>
        <form action={formAction} className="space-y-4">
          <input type="hidden" name="next" value={next} />
          {signup && (
            <div>
              <label className="label" htmlFor="displayName">
                Name your friends will see
              </label>
              <input
                className="input"
                id="displayName"
                name="displayName"
                required
                maxLength={40}
                autoComplete="nickname"
                defaultValue={guestName}
              />
            </div>
          )}
          <div>
            <label className="label" htmlFor="email">
              Email
            </label>
            <input className="input" id="email" name="email" type="email" required autoComplete="email" />
          </div>
          <div>
            <label className="label" htmlFor="password">
              Password
            </label>
            <input
              className="input"
              id="password"
              name="password"
              type="password"
              required
              minLength={signup ? 8 : undefined}
              autoComplete={signup ? "new-password" : "current-password"}
            />
            {signup && <p className="mt-1.5 text-xs text-ink-3">At least 8 characters. Stored salted and hashed.</p>}
          </div>
          {state.error && (
            <p role="alert" className="rounded-lg border border-seal/30 bg-seal-soft px-3 py-2 text-sm text-seal-ink">
              {state.error}
            </p>
          )}
          <button className="btn w-full" disabled={pending}>
            {pending ? "One moment…" : signup ? "Create account" : "Log in"}
          </button>
        </form>
        {!upgrading && (
          <>
            <p className="mt-5 text-center text-sm text-ink-2">
              {signup ? "Already have an account? " : joining ? "No account yet? " : "New here? "}
              <Link className="link text-ink" href={`/${signup ? "login" : "signup"}?next=${encodeURIComponent(next)}`}>
                {signup ? "Log in" : joining ? "Sign up to join" : "Sign up"}
              </Link>
            </p>
            <p className="mt-2 text-center text-sm text-ink-2">
              {joining ? "Don't want an account? " : "Have a plan code? "}
              <Link className="link text-ink" href={code ? `/guest?code=${encodeURIComponent(code)}` : "/guest"}>
                Continue as a guest
              </Link>
            </p>
          </>
        )}
      </div>
    </div>
  );
}
