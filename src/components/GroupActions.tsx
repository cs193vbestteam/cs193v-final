"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { planPulseAction, runNegotiationAction } from "@/app/actions";

export function NegotiateButton({
  eventId,
  inviteCode,
  readyCount,
  memberCount,
  decided,
  noPlan = false,
  canRerun = true,
}: {
  eventId: string;
  inviteCode: string;
  readyCount: number;
  memberCount: number;
  decided: boolean;
  /** The last run found nothing that works, so there is no plan to call one. */
  noPlan?: boolean;
  /** For a decided plan: whether anyone has changed an answer or joined since. Without that a run gives the same plan (#118). */
  canRerun?: boolean;
}) {
  const everyoneDone = readyCount >= 2 && readyCount === memberCount;
  const nothingNew = decided && everyoneDone && !canRerun;
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Until everyone is done there is nothing to press, and the card above says what is awaited.
  if (!decided && !everyoneDone) return null;
  return (
    <div>
      <button
        className={`${decided ? "btn-ghost" : "btn"} w-full`}
        disabled={pending || !everyoneDone || nothingNew}
        aria-describedby="rerun-why"
        onClick={() =>
          start(async () => {
            const res = await runNegotiationAction(eventId, inviteCode);
            setError(res.error ?? null);
          })
        }
      >
        {pending ? "Finding a plan…" : decided ? "Re-run with latest info" : "Find a plan"}
      </button>
      {memberCount >= 2 && readyCount < memberCount && (
        <p id="rerun-why" className="sr-only">
          {readyCount} of {memberCount} people ready. Waiting for everyone to finish.
        </p>
      )}
      {nothingNew && (
        <p id="rerun-why" className="sr-only">
          {noPlan
            ? "Nothing has changed since the last try. It can be run again once someone changes an answer."
            : "This is the plan for everyone\u2019s current answers. It can be run again once someone changes theirs."}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm text-seal-ink">
          {error}
        </p>
      )}
    </div>
  );
}

export function CopyInvite({ url }: { url: string }) {
  const [feedback, setFeedback] = useState<{ url: string; status: "copying" | "copied" | "failed" } | null>(null);
  const request = useRef(0);
  const status = feedback?.url === url ? feedback.status : null;

  useEffect(() => {
    // Ignore results from a previous URL or an unmounted component. Feedback for an old URL
    // needs no clearing: `status` above only reads feedback that belongs to the current one.
    return () => {
      request.current += 1;
    };
  }, [url]);

  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setFeedback(null), 1500);
    return () => clearTimeout(timer);
  }, [status, url]);

  async function copy() {
    const attempt = ++request.current;
    setFeedback({ url, status: "copying" });
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(url);
      if (attempt === request.current) setFeedback({ url, status: "copied" });
    } catch {
      if (attempt === request.current) setFeedback({ url, status: "failed" });
    }
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        className={`${status === "copied" ? "btn" : "btn-ghost"} btn-sm w-full`}
        disabled={status === "copying"}
        onClick={copy}
      >
        {status === "copied" ? "Copied!" : status === "copying" ? "Copying…" : "Copy invite link"}
      </button>
      <div role="status" className="text-xs text-ink-3">
        {status === "copied" && "Invitation link copied."}
        {status === "failed" && "Couldn't copy automatically. Copy the invitation link below, or try again."}
      </div>
      {status === "failed" && (
        <label className="block text-xs text-ink-3">
          Invitation link
          <input
            className="input mt-1 font-mono text-xs"
            type="text"
            readOnly
            value={url}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}

/**
 * Hands a ready-made message to the group chat everyone already reads: the system share
 * sheet where the browser has one (phones), the clipboard otherwise. The message is built
 * on the server from what the whole group can already see, so it carries nobody's limits.
 */
export function ShareMessage({
  label,
  message,
  primary = false,
}: {
  label: string;
  /** The full text to send, link included. */
  message: string;
  primary?: boolean;
}) {
  const [feedback, setFeedback] = useState<{ message: string; status: "copied" | "failed" } | null>(null);
  const status = feedback?.message === message ? feedback.status : null;

  useEffect(() => {
    if (status !== "copied") return;
    const timer = setTimeout(() => setFeedback(null), 2500);
    return () => clearTimeout(timer);
  }, [status]);

  async function share() {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text: message });
        return;
      } catch (err) {
        // Closing the share sheet is a choice, not a failure.
        if ((err as Error)?.name === "AbortError") return;
      }
    }
    try {
      if (typeof navigator.clipboard?.writeText !== "function") throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(message);
      setFeedback({ message, status: "copied" });
    } catch {
      setFeedback({ message, status: "failed" });
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" className={`${primary ? "btn" : "btn-ghost btn-sm"} w-full`} onClick={share}>
        {status === "copied" ? "Copied!" : label}
      </button>
      <div role="status" className="text-xs text-ink-3">
        {status === "copied" && "Message copied. Paste it in your group chat."}
        {status === "failed" && "Couldn't copy automatically. Copy the message below."}
      </div>
      {status === "failed" && (
        <label className="block text-xs text-ink-3">
          Message for the group
          <textarea
            className="input mt-1 text-xs"
            rows={3}
            readOnly
            value={message}
            onFocus={(event) => event.currentTarget.select()}
          />
        </label>
      )}
    </div>
  );
}

/**
 * Live updates. Every few seconds the page asks the server one small question: has anything
 * about this plan changed since it was rendered? Only then is the page re-rendered. A hidden
 * tab asks nothing, and asks at once when it is looked at again.
 */
export function AutoRefresh({ eventId, pulse, ms = 5000 }: { eventId: string; pulse: string | null; ms?: number }) {
  const router = useRouter();
  const shown = useRef(pulse);
  useEffect(() => {
    shown.current = pulse;
  }, [pulse]);
  useEffect(() => {
    let busy = false;
    async function check() {
      if (busy || document.hidden) return;
      busy = true;
      try {
        const now = await planPulseAction(eventId);
        if (now !== shown.current) {
          shown.current = now;
          router.refresh();
        }
      } catch {
        // Offline or mid-deploy: the next tick asks again.
      } finally {
        busy = false;
      }
    }
    const id = setInterval(check, ms);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", check);
    };
  }, [router, eventId, ms]);
  return null;
}
