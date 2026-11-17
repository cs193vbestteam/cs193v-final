"use client";

import { useState, useTransition } from "react";
import { removeMemberAction, resetInviteAction, setMaxMembersAction } from "@/app/actions";
import { ConfirmAction } from "@/components/DangerActions";

type Props = {
  eventId: string;
  inviteCode: string;
  /** Everyone in the plan except the creator. */
  others: { userId: string; displayName: string }[];
  /** How many people are in the plan now, the creator included. */
  joined: number;
  maxMembers: number;
  /** The fewest and the most a creator may choose. */
  minSize: number;
  maxSize: number;
};

/**
 * What only the plan's creator sees. An invite link gets forwarded, so the creator can take
 * someone out, replace the link, and set how many people fit (#119).
 */
export function CreatorControls({ eventId, inviteCode, others, joined, maxMembers, minSize, maxSize }: Props) {
  const [size, setSize] = useState(maxMembers);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, start] = useTransition();
  const lowest = Math.max(minSize, joined);
  const sizes = Array.from({ length: maxSize - lowest + 1 }, (_, i) => lowest + i);

  return (
    <details className="group">
      <summary className="link w-fit cursor-pointer list-none text-sm text-ink-2 [&::-webkit-details-marker]:hidden">
        Manage people and the invite link
      </summary>
      <div className="mt-3 space-y-4">
        <form
          className="space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            start(async () => {
              const res = await setMaxMembersAction(eventId, inviteCode, size);
              setNote(
                res.error
                  ? { text: res.error, error: true }
                  : { text: `At most ${size} people can join this plan.`, error: false },
              );
            });
          }}
        >
          <label htmlFor="plan-size" className="label">
            How many people can join
          </label>
          <div className="flex items-center gap-2">
            <select
              id="plan-size"
              className="input !w-auto"
              value={size}
              onChange={(e) => {
                setSize(Number(e.target.value));
                setNote(null);
              }}
            >
              {sizes.map((n) => (
                <option key={n} value={n}>
                  {n} people
                </option>
              ))}
            </select>
            <button className="btn-ghost btn-sm" disabled={pending || size === maxMembers}>
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
          <p className="text-xs text-ink-3">
            {joined} of {maxMembers} places taken, you included.
          </p>
          {note && (
            <p
              role={note.error ? "alert" : "status"}
              className={`text-sm ${note.error ? "text-seal-ink" : "text-moss"}`}
            >
              {note.text}
            </p>
          )}
        </form>

        <ConfirmAction
          label="Replace the invite link"
          title="Replace the invite link?"
          consequences={[
            "The link you shared stops working, for everyone who has it",
            "People already in the plan stay in it",
            "You will need to send the new link to anyone who has not joined yet",
          ]}
          confirmLabel="Replace link"
          action={() => resetInviteAction(eventId, inviteCode)}
        />

        {others.length > 0 && (
          <div>
            <p className="label">Remove someone</p>
            <ul className="mt-1 space-y-1.5">
              {others.map((m) => (
                <li key={m.userId}>
                  <ConfirmAction
                    label={`Remove ${m.displayName}`}
                    title={`Remove ${m.displayName} from this plan?`}
                    consequences={[
                      `${m.displayName}'s private chat and constraints for this plan`,
                      "The current result, if there is one: the group will need to find a plan again",
                      "They can join again with the invite link, unless you replace it",
                    ]}
                    confirmLabel={`Remove ${m.displayName}`}
                    action={() => removeMemberAction(eventId, inviteCode, m.userId)}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </details>
  );
}
