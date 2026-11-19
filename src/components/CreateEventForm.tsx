"use client";

import { useActionState, useState } from "react";
import { createEventAction } from "@/app/actions";
import { addDays, formatPlanDate } from "@/lib/plan-date";

/** Names to start from. A press fills the field; it can still be edited. */
const NAME_IDEAS = ["Saturday dinner", "Birthday lunch", "Team dinner", "Sunday brunch"];
/** How many days are offered as one-press choices. Later dates use the date field. */
const DAY_CHOICES = 7;

const dayLabel = (date: string, i: number) =>
  i === 0 ? "Today" : i === 1 ? "Tomorrow" : formatPlanDate(date).replace(/^(\w+), \w+ (\d+)$/, "$1 $2");

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

  const days = Array.from({ length: DAY_CHOICES }, (_, i) => addDays(minDate, i)).filter((d) => d <= maxDate);
  const smallest = sizes[0];
  const largest = sizes[sizes.length - 1];
  const real = realPlaces && location.trim().length > 0;
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(date);

  return (
    <form action={action} className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-10">
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
          <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label="Name ideas">
            {NAME_IDEAS.map((idea) => (
              <button key={idea} type="button" className="pick" onClick={() => setTitle(idea)}>
                {idea}
              </button>
            ))}
          </div>
        </div>

        <div>
          <span id="plan-day-label" className="label">
            When
          </span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-labelledby="plan-day-label">
            {days.map((d, i) => (
              <button
                key={d}
                type="button"
                className="pick pick-day"
                aria-pressed={d === date}
                onClick={() => setDate(d)}
              >
                {dayLabel(d, i)}
              </button>
            ))}
          </div>
          <div className="mt-2.5 flex items-center gap-3">
            <label htmlFor="plan-date" className="label !mb-0 shrink-0">
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
          <div className="flex items-baseline justify-between gap-3">
            <label htmlFor="plan-size" className="label !mb-0">
              Maximum group size
            </label>
            <output htmlFor="plan-size" className="font-serif text-2xl leading-none tabular-nums">
              {/* Keyed by the number, so each change rolls the new one in. */}
              <span key={size} className="size-roll">
                {size}
              </span>{" "}
              <span className="font-sans text-sm text-ink-2">people</span>
            </output>
          </div>
          <input
            id="plan-size"
            className="size-range mt-3"
            type="range"
            name="maxMembers"
            min={smallest}
            max={largest}
            step={1}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
            aria-describedby="plan-size-hint"
            style={
              { "--fill": `${((size - smallest) / Math.max(1, largest - smallest)) * 100}%` } as React.CSSProperties
            }
          />
          <div aria-hidden className="mt-2 flex gap-1">
            {Array.from({ length: largest }, (_, i) => (
              <span key={i} className="size-seat" data-on={i < size || undefined} />
            ))}
          </div>
          {/* A tester read the size as the number of people a plan needs, and doubted two could finish one (#155). */}
          <p id="plan-size-hint" className="mt-2 text-xs text-ink-3">
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
      <div className="flex flex-col gap-4">
        <div aria-hidden className="plan-ticket">
          <p className="font-mono text-[0.75rem] uppercase tracking-[0.14em] text-paper/70">Your plan</p>
          <p className={`mt-2 break-words font-serif text-2xl leading-tight ${title.trim() ? "" : "text-paper/45"}`}>
            {title.trim() || "Name it…"}
          </p>
          <dl className="mt-4 space-y-1.5 text-sm">
            <div className="flex justify-between gap-3">
              <dt className="text-paper/70">When</dt>
              <dd>{validDate ? formatPlanDate(date) : "Pick a day"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-paper/70">Where</dt>
              <dd className="truncate">{location.trim() || "Sample places"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-paper/70">Room for</dt>
              <dd>up to {size}</dd>
            </div>
          </dl>
          <div className="plan-ticket-tear" />
          <p className="font-mono text-[0.75rem] uppercase tracking-[0.14em] text-paper/70">Plan code</p>
          <p className="mt-1 font-mono text-lg tracking-[0.3em]">••••••••</p>
          <p className="mt-1 text-xs text-paper/70">Made when you start. Share it and friends join.</p>
        </div>
        <button className="btn btn-lg w-full" disabled={pending}>
          {pending ? "Creating…" : "Start a plan"}
          {!pending && <Arrow />}
        </button>
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
