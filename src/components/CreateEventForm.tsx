"use client";

import { useActionState } from "react";
import { createEventAction } from "@/app/actions";

/** `minDate` and `maxDate` (YYYY-MM-DD) come from the server, which checks the date again on submit. */
export function CreateEventForm({ minDate, maxDate }: { minDate: string; maxDate: string }) {
  const [state, action, pending] = useActionState(createEventAction, {});
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="min-w-0 flex-1">
          <label htmlFor="plan-title" className="label">
            Plan name
          </label>
          <input
            id="plan-title"
            className="input sm:text-base"
            name="title"
            placeholder="Saturday dinner with the crew"
            required
            maxLength={80}
            autoComplete="off"
          />
        </div>
        <div className="sm:w-[14rem]">
          <label htmlFor="plan-location" className="label">
            Near where (optional)
          </label>
          <input
            id="plan-location"
            className="input"
            name="location"
            placeholder="e.g. Palo Alto"
            maxLength={120}
            autoComplete="off"
          />
        </div>
        <div className="sm:w-[11rem]">
          <label htmlFor="plan-date" className="label">
            Date
          </label>
          <input
            id="plan-date"
            className="input"
            type="date"
            name="date"
            required
            min={minDate}
            max={maxDate}
            defaultValue={minDate}
          />
        </div>
        <button className="btn shrink-0" disabled={pending}>
          {pending ? "Creating…" : "Start a plan"}
          {!pending && <Arrow />}
        </button>
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-seal-ink">
          {state.error}
        </p>
      )}
    </form>
  );
}

function Arrow() {
  return (
    <svg aria-hidden width="14" height="14" viewBox="0 0 16 16" fill="none" className="-mr-1">
      <path
        d="M3 8h9M8.5 3.5 13 8l-4.5 4.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
