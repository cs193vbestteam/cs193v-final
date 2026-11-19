"use client";

import { useActionState, useState } from "react";
import { createEventAction } from "@/app/actions";
import { formatPlanDate } from "@/lib/plan-date";

/** `minDate` and `maxDate` (YYYY-MM-DD) come from the server, which checks the date again on submit. */
export function CreateEventForm({
  minDate,
  maxDate,
  sizes,
  defaultSize,
  realPlaces,
}: {
  minDate: string;
  maxDate: string;
  /** How many people the plan may take: the choices, and the one selected to begin with. */
  sizes: number[];
  defaultSize: number;
  /** Whether a plan with a location gets real restaurants here. Decides what the form promises. */
  realPlaces: boolean;
}) {
  const [state, action, pending] = useActionState(createEventAction, {});
  // Held here because the ticket beside the form shows them as they are typed, and because
  // React clears a form's own values after its action: a refused plan would lose everything.
  const [title, setTitle] = useState("");
  const [location, setLocation] = useState("");
  const [date, setDate] = useState(minDate);
  const [size, setSize] = useState(defaultSize);

  const smallest = sizes[0];
  const largest = sizes[sizes.length - 1];
  const real = realPlaces && location.trim().length > 0;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);

  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_21rem] lg:items-center lg:gap-10">
      <div className="space-y-6">
        <div>
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
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div>
          <label htmlFor="plan-date" className="label">
            Date
          </label>
          <input
            id="plan-date"
            className="input sm:w-[11rem]"
            type="date"
            name="date"
            required
            min={minDate}
            max={maxDate}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>

        <div>
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
            value={location}
            onChange={(e) => setLocation(e.target.value)}
            aria-describedby="plan-source"
          />
          {/* Which restaurants this plan will choose from, said before the plan is made. */}
          <p id="plan-source" className="mt-2 flex items-start gap-2 text-xs text-ink-2">
            <span className={`pill shrink-0 ${real ? "pill-moss" : "pill-amber"}`}>
              {real ? "Real places" : "Sample data"}
            </span>
            <span className="pt-0.5">
              {real
                ? "The plan will choose from real restaurants near there."
                : realPlaces
                  ? "Add a place to choose from real restaurants nearby. Left blank, the plan uses made-up sample restaurants."
                  : "Plans in this version pick from made-up sample restaurants, not real places."}
            </span>
          </p>
        </div>

        <div>
          <label htmlFor="plan-size" className="label">
            Maximum group size
          </label>
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="size-step"
              aria-label="One fewer person"
              disabled={size <= smallest}
              onClick={() => setSize((n) => Math.max(smallest, n - 1))}
            >
              <svg aria-hidden viewBox="0 0 16 16" width="16" height="16">
                <path d="M3.5 8h9" />
              </svg>
            </button>
            {/* The number on two rolling tiles. The slider beside it carries the value and its name. */}
            <span aria-hidden className="odometer">
              {[Math.floor(size / 10), size % 10].map((digit, place) => (
                <span key={place} className="odometer-tile">
                  <span className="odometer-reel" style={{ "--digit": digit } as React.CSSProperties}>
                    {Array.from({ length: 10 }, (_, n) => (
                      <span key={n}>{n}</span>
                    ))}
                  </span>
                </span>
              ))}
            </span>
            <button
              type="button"
              className="size-step"
              aria-label="One more person"
              disabled={size >= largest}
              onClick={() => setSize((n) => Math.min(largest, n + 1))}
            >
              <svg aria-hidden viewBox="0 0 16 16" width="16" height="16">
                <path d="M3.5 8h9M8 3.5v9" />
              </svg>
            </button>
            <input
              id="plan-size"
              className="size-range min-w-0 flex-1"
              type="range"
              name="maxMembers"
              min={smallest}
              max={largest}
              step={1}
              value={size}
              onChange={(e) => setSize(Number(e.target.value))}
              aria-describedby="plan-size-hint"
              aria-valuetext={`${size} people`}
              style={
                { "--fill": `${((size - smallest) / Math.max(1, largest - smallest)) * 100}%` } as React.CSSProperties
              }
            />
          </div>
          {/* A tester read the size as the number of people a plan needs, and doubted two could finish one (#155). */}
          <p id="plan-size-hint" className="mt-2.5 text-xs text-ink-3">
            The group size is a limit, not a target. Two people are enough for a plan.
          </p>
        </div>

        {state.error && (
          <p role="alert" className="text-sm text-seal-ink">
            {state.error}
          </p>
        )}
      </div>

      {/* The plan as it will look, filled in as they type. A picture of the fields, so it is hidden from screen readers. */}
      <div className="mx-auto flex w-full max-w-[25rem] flex-col gap-5 lg:max-w-none">
        <div aria-hidden className="plan-ticket" data-tilt>
          <div className="plan-ticket-main">
            <p className="plan-ticket-eyebrow">Settle · your plan</p>
            <p className={`plan-ticket-title ${title.trim() ? "" : "opacity-45"}`}>{title.trim() || "Name it…"}</p>
            <dl className="plan-ticket-facts">
              <div>
                <dt>When</dt>
                <dd>{validDate ? formatPlanDate(date) : "Pick a day"}</dd>
              </div>
              <div>
                <dt>Where</dt>
                <dd>{location.trim() || "Sample places"}</dd>
              </div>
            </dl>
          </div>
          <div className="plan-ticket-stub">
            <p className="plan-ticket-eyebrow">Admit</p>
            <p className="plan-ticket-count">
              <span key={size} className="size-roll">
                {size}
              </span>
            </p>
            <p className="plan-ticket-eyebrow">at most</p>
            <p className="plan-ticket-code">••••••••</p>
          </div>
        </div>
        <button className="btn btn-lg w-full" disabled={pending}>
          {pending ? "Creating…" : "Start a plan"}
          {!pending && <Arrow />}
        </button>
        <p className="-mt-2 text-center text-xs text-ink-3">The plan code is made when you start.</p>
      </div>
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
