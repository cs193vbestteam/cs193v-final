"use client";

import { useActionState } from "react";
import { createEventAction } from "@/app/actions";

export function CreateEventForm() {
  const [state, action, pending] = useActionState(createEventAction, {});
  return (
    <form action={action} className="flex flex-col gap-2 sm:flex-row">
      <input className="input" name="title" placeholder="e.g. Saturday dinner with the crew" required maxLength={80} />
      <button className="btn shrink-0" disabled={pending}>{pending ? "Creating…" : "Start a plan"}</button>
      {state.error && <p role="alert" className="text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
