"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { runNegotiationAction } from "@/app/actions";

export function NegotiateButton({ eventId, inviteCode, readyCount, memberCount, decided }: { eventId: string; inviteCode: string; readyCount: number; memberCount: number; decided: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        className="btn w-full"
        disabled={pending || readyCount < 2 || readyCount !== memberCount}
        onClick={() =>
          start(async () => {
            const res = await runNegotiationAction(eventId, inviteCode);
            setError(res.error ?? null);
          })
        }
      >
        {pending ? "Assistants negotiating…" : decided ? "Re-run with latest info" : "Find a plan"}
      </button>
      {readyCount < 2 && <p className="mt-2 text-center text-xs text-ink-3">Needs at least 2 people marked done.</p>}
      {memberCount >= 2 && readyCount < memberCount && (
        <p className="mt-2 text-center text-xs text-ink-3">{readyCount} of {memberCount} people ready. Waiting for everyone to finish.</p>
      )}
      {error && <p role="alert" className="mt-2 text-sm text-seal">{error}</p>}
    </div>
  );
}

export function CopyInvite({ url }: { url: string }) {
  const [feedback, setFeedback] = useState<{ url: string; status: "copying" | "copied" | "failed" } | null>(null);
  const request = useRef(0);
  const status = feedback?.url === url ? feedback.status : null;

  useEffect(() => {
    setFeedback(null);
    // Ignore results from a previous URL or an unmounted component.
    return () => { request.current += 1; };
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
          <input className="input mt-1 font-mono text-xs" type="text" readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
        </label>
      )}
    </div>
  );
}

/** Lightweight live updates: re-fetch server data every few seconds. */
export function AutoRefresh({ ms = 5000 }: { ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = setInterval(() => router.refresh(), ms);
    return () => clearInterval(id);
  }, [router, ms]);
  return null;
}
