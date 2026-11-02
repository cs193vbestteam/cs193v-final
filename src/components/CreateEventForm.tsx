"use client";

import { useActionState } from "react";
import { createEventAction } from "@/app/actions";

export function CreateEventForm() {
  const [state, action, pending] = useActionState(createEventAction, {});
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-col gap-2 sm:flex-row">
        <label htmlFor="plan-title" className="sr-only">Plan name</label>
        <input
          id="plan-title"
          className="input sm:text-base"
          name="title"
          placeholder="Saturday dinner with the crew"
          required
          maxLength={80}
          autoComplete="off"
        />
        <button className="btn shrink-0" disabled={pending}>
          {pending ? "Creating…" : "Start a plan"}
          {!pending && <Arrow />}
        </button>
      </div>
      {state.error && <p role="alert" className="text-sm text-seal">{state.error}</p>}
    </form>
  );
}

function Arrow() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" className="-mr-1">
      <path d="M3 8h9M8.5 3.5 13 8l-4.5 4.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
