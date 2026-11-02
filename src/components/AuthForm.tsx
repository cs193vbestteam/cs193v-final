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
  return (
    <div className="mx-auto mt-10 max-w-sm card">
      <h1 className="mb-4 text-xl font-semibold">{signup ? "Create an account" : "Welcome back"}</h1>
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="next" value={next} />
        {signup && (
          <div>
            <label className="label" htmlFor="displayName">Name your friends will see</label>
            <input className="input" id="displayName" name="displayName" required maxLength={40} />
          </div>
        )}
        <div>
          <label className="label" htmlFor="email">Email</label>
          <input className="input" id="email" name="email" type="email" required autoComplete="email" />
        </div>
        <div>
          <label className="label" htmlFor="password">Password</label>
          <input
            className="input"
            id="password"
            name="password"
            type="password"
            required
            minLength={signup ? 8 : undefined}
            autoComplete={signup ? "new-password" : "current-password"}
          />
        </div>
        {state.error && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
        <button className="btn w-full" disabled={pending}>
          {pending ? "…" : signup ? "Sign up" : "Log in"}
        </button>
      </form>
      <p className="mt-4 text-center text-sm text-muted">
        {signup ? "Already have an account? " : "New here? "}
        <Link className="text-accent underline" href={`/${signup ? "login" : "signup"}?next=${encodeURIComponent(next)}`}>
          {signup ? "Log in" : "Sign up"}
        </Link>
      </p>
    </div>
  );
}
