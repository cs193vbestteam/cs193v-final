"use client";

import Link from "next/link";
import { useActionState } from "react";
import type { FormState } from "@/app/actions";

type Props = {
  mode: "login" | "signup";
  action: (state: FormState, form: FormData) => Promise<FormState>;
  next: string;
};

export function AuthForm({ mode, action, next }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const signup = mode === "signup";
  const joining = next.startsWith("/e/");
  return (
    <div className="mx-auto mt-8 grid max-w-4xl items-start gap-10 sm:mt-16 lg:grid-cols-[1fr_minmax(0,24rem)]">
      <div className="rise max-w-md" style={{ "--d": "0s" } as React.CSSProperties}>
        <p className="eyebrow">{signup ? "New account" : "Welcome back"}</p>
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
          {joining
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
        <p className="mt-5 text-center text-sm text-ink-2">
          {signup ? "Already have an account? " : "New here? "}
          <Link className="link text-ink" href={`/${signup ? "login" : "signup"}?next=${encodeURIComponent(next)}`}>
            {signup ? "Log in" : "Sign up"}
          </Link>
        </p>
      </div>
    </div>
  );
}
