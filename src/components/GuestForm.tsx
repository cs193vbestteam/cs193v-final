"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { guestAction, type FormState } from "@/app/actions";
import { CodeSlots } from "./CodeSlots";

/** Joining with a plan code and a name, no account (#160). */
export function GuestForm({ code }: { code: string }) {
  const [state, formAction, pending] = useActionState<FormState, FormData>(guestAction, {});
  // Held here so a refused code does not also wipe the name: React clears a form's own values after its action.
  const [typedCode, setTypedCode] = useState(code);
  const [name, setName] = useState("");
  const next = code ? `/e/${code}` : "/";
  return (
    <div className="mx-auto mt-8 grid max-w-4xl items-start gap-10 sm:mt-16 lg:grid-cols-[1fr_minmax(0,24rem)]">
      <div className="rise max-w-md" style={{ "--d": "0s" } as React.CSSProperties}>
        <p className="eyebrow">{code ? "You're invited" : "No account needed"}</p>
        <h1 className="display mt-4 text-5xl sm:text-6xl">
          Just the <em>code.</em>
        </h1>
        <p className="lede mt-5">
          Enter the plan code and a name, and you&apos;re in. You get the same private assistant as everyone else;
          nobody in the group sees what you tell it.
        </p>
        <p className="mt-4 text-sm text-ink-2">
          As a guest you stay in this plan on this browser only. To open it on another device, or to start a plan of
          your own, add an email and password later from the Account page.
        </p>
      </div>

      <div className="card rise" style={{ "--d": "0.12s" } as React.CSSProperties}>
        <form action={formAction} className="space-y-4">
          <div>
            <label className="label" htmlFor="code">
              Plan code
            </label>
            <CodeSlots
              id="code"
              name="code"
              value={typedCode}
              onChange={setTypedCode}
              invalid={!!state.error && /code/i.test(state.error)}
              describedBy="code-hint"
            />
            <p id="code-hint" className="mt-1.5 text-xs text-ink-3">
              The letters and numbers at the end of the invite link. You can paste the whole link.
            </p>
          </div>
          <div>
            <label className="label" htmlFor="displayName">
              Name your friends will see
            </label>
            <input
              className="input"
              id="displayName"
              name="displayName"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={40}
              autoComplete="nickname"
            />
          </div>
          {state.error && (
            <p role="alert" className="rounded-lg border border-seal/30 bg-seal-soft px-3 py-2 text-sm text-seal-ink">
              {state.error}
            </p>
          )}
          <button className="btn w-full" disabled={pending}>
            {pending ? "One moment…" : "Continue as a guest"}
          </button>
        </form>
        <p className="mt-5 text-center text-sm text-ink-2">
          Have an account?{" "}
          <Link className="link text-ink" href={`/login?next=${encodeURIComponent(next)}`}>
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
