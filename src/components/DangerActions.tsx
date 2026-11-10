"use client";

import { useActionState, useEffect, useId, useRef, useState, useTransition } from "react";
import { deleteAccountAction, deletePlanAction, leavePlanAction } from "@/app/actions";

type Result = { error?: string };

type ConfirmProps = {
  /** The quiet button that opens the confirmation. */
  label: string;
  /** One line: what is about to happen. */
  title: string;
  /** Exactly what will be removed, one item per line. */
  consequences: string[];
  /** The button that does it. */
  confirmLabel: string;
  /** Resolves with an error to show, or never returns because the action redirects. */
  action: () => Promise<Result>;
};

/**
 * A destructive action in two steps: the trigger only opens a panel that says
 * what will be removed and that it cannot be undone; a second, explicit click does it.
 * Cancel and Escape close the panel and put focus back on the trigger.
 */
export function ConfirmAction({ label, title, consequences, confirmLabel, action }: ConfirmProps) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const trigger = useRef<HTMLButtonElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (open) cancel.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setError(null);
    trigger.current?.focus();
  }

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape" && open && !pending) close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="link text-sm text-ink-2"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        {label}
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={title}
          className="mt-3 rounded-xl border border-seal/35 bg-seal-soft/60 px-4 py-3.5"
        >
          <p className="text-sm font-medium text-ink">{title}</p>
          <ul className="mt-2 space-y-1 text-sm text-ink-2">
            {consequences.map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-seal" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-ink-2">This cannot be undone.</p>
          <div className="mt-3.5 flex flex-wrap gap-2">
            <button ref={cancel} type="button" className="btn-ghost btn-sm" disabled={pending} onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await action();
                  setError(res?.error ?? null);
                })
              }
            >
              {pending ? "Working…" : confirmLabel}
            </button>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-seal-ink">
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * On the plan page. Everyone but the creator can leave. The creator can delete the plan
 * for everyone, and, once someone else has joined, can instead leave and hand it over.
 */
export function PlanDangerZone({
  eventId,
  inviteCode,
  isCreator,
  title,
  nextOwner,
}: {
  eventId: string;
  inviteCode: string;
  isCreator: boolean;
  title: string;
  /** Who the plan passes to if the creator leaves: the earliest other member. Undefined when the creator is alone. */
  nextOwner?: string;
}) {
  const leave = (
    <ConfirmAction
      label="Leave this plan"
      title={`Leave “${title}”?`}
      consequences={[
        "Your private chat and constraints for this plan",
        "The current result, if there is one: the group will need to find a plan again",
        ...(isCreator && nextOwner ? [`The plan stays for the others and passes to ${nextOwner}`] : []),
      ]}
      confirmLabel="Leave plan"
      action={() => leavePlanAction(eventId, inviteCode)}
    />
  );
  if (!isCreator) return leave;
  return (
    <div className="space-y-2.5">
      {nextOwner && leave}
      <ConfirmAction
        label="Delete this plan"
        title={`Delete “${title}” for everyone?`}
        consequences={[
          "The plan and its result",
          "Every member's private chat and constraints for this plan",
          "The invite link stops working",
        ]}
        confirmLabel="Delete plan"
        action={() => deletePlanAction(eventId, inviteCode)}
      />
    </div>
  );
}

/** Account deletion: same two steps, and the password is asked again before anything is removed. */
export function DeleteAccountForm() {
  const [state, formAction, pending] = useActionState(deleteAccountAction, {});
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const password = useRef<HTMLInputElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (open) password.current?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <div
      onKeyDown={(e) => {
        if (e.key === "Escape" && open && !pending) close();
      }}
    >
      <button
        ref={trigger}
        type="button"
        className="btn-ghost btn-sm"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => (open ? close() : setOpen(true))}
      >
        Delete my account…
      </button>
      {open && (
        <form
          id={panelId}
          action={formAction}
          aria-label="Delete your account?"
          className="mt-4 rounded-xl border border-seal/35 bg-seal-soft/60 px-4 py-4"
        >
          <p className="text-sm font-medium text-ink">Delete your account?</p>
          <ul className="mt-2 space-y-1 text-sm text-ink-2">
            {[
              "Your account, including your email and password",
              "Your private chats and constraints in every plan",
              "Plans you created that nobody else has joined; the others pass to the earliest member",
              "Results of plans you are in: those groups will need to find a plan again",
            ].map((c) => (
              <li key={c} className="flex gap-2">
                <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-seal" />
                <span>{c}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-sm text-ink-2">This cannot be undone.</p>
          <div className="mt-4 max-w-xs">
            <label className="label" htmlFor="delete-password">
              Confirm with your password
            </label>
            <input
              ref={password}
              className="input"
              id="delete-password"
              name="password"
              type="password"
              required
              autoComplete="current-password"
            />
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <button type="button" className="btn-ghost btn-sm" disabled={pending} onClick={close}>
              Cancel
            </button>
            <button className="btn btn-sm" disabled={pending}>
              {pending ? "Deleting…" : "Delete account permanently"}
            </button>
          </div>
          {state.error && (
            <p role="alert" className="mt-3 text-sm text-seal-ink">
              {state.error}
            </p>
          )}
        </form>
      )}
    </div>
  );
}
