"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { runNegotiationAction } from "@/app/actions";

export function NegotiateButton({ eventId, inviteCode, readyCount, decided }: { eventId: string; inviteCode: string; readyCount: number; decided: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <button
        className="btn w-full"
        disabled={pending || readyCount < 2}
        onClick={() =>
          start(async () => {
            const res = await runNegotiationAction(eventId, inviteCode);
            setError(res.error ?? null);
          })
        }
      >
        {pending ? "Assistants negotiating…" : decided ? "Re-run with latest info" : "Find a plan"}
      </button>
      {readyCount < 2 && <p className="mt-1 text-xs text-muted">Needs at least 2 people marked done.</p>}
      {error && <p role="alert" className="mt-1 text-sm text-red-600">{error}</p>}
    </div>
  );
}

export function CopyInvite({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="btn-ghost w-full truncate text-xs"
      onClick={async () => {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? "Copied!" : `Copy invite link`}
    </button>
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
