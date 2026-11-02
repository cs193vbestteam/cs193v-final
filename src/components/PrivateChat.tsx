"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { sendMessageAction, setReadyAction } from "@/app/actions";
import type { MissingField } from "@/lib/constraints";
import type { ChatTurn } from "@/lib/extract";

type Props = {
  eventId: string;
  inviteCode: string;
  initialMessages: ChatTurn[];
  initialSummary: string[];
  initialMissing: MissingField[];
  ready: boolean;
};

const MISSING_LABEL: Record<MissingField, string> = { time: "when", budget: "budget", distance: "distance", diet: "diet" };

type ChatSnapshot = {
  eventId: string;
  messages: ChatTurn[];
  summary: string[];
  missing: MissingField[];
};

export function PrivateChat({ eventId, inviteCode, initialMessages, initialSummary, initialMissing, ready }: Props) {
  const [localReply, setLocalReply] = useState<ChatSnapshot | null>(null);
  const [submission, setSubmission] = useState<ChatSnapshot | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);

  const serverSnapshot: ChatSnapshot = { eventId, messages: initialMessages, summary: initialSummary, missing: initialMissing };
  // Chats are append-only. Keep a completed send until server props catch up,
  // then render refreshed props directly instead of copying them into state.
  const latest = localReply?.eventId === eventId && localReply.messages.length > initialMessages.length
    ? localReply : serverSnapshot;
  // A refresh during a send must not erase its optimistic message or draft.
  const { messages, summary, missing } = submission?.eventId === eventId ? submission : latest;

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || pending) return;
    setText("");
    setError(null);
    setSubmission({ eventId, messages: [...messages, { role: "user", content: msg }], summary, missing });
    startTransition(async () => {
      try {
        const res = await sendMessageAction(eventId, inviteCode, msg);
        if ("messages" in res) {
          setLocalReply({ eventId, messages: res.messages, summary: res.summary, missing: res.missing });
        } else {
          setError(res.error);
          setText((draft) => draft || msg);
        }
      } catch {
        setError("Couldn't send your message. Please try again.");
        setText((draft) => draft || msg);
      } finally {
        setSubmission(null);
      }
    });
  }

  function toggleReady() {
    setError(null);
    startTransition(async () => {
      const res = await setReadyAction(eventId, inviteCode, !ready);
      if (res.error) setError(res.error);
    });
  }

  return (
    <section className="card flex h-[36rem] flex-col">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Your private assistant</h2>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-xs text-accent">🔒 only you can see this</span>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto pr-1" aria-live="polite">
        {messages.map((m, i) => (
          <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm ${
                m.role === "user" ? "bg-accent text-white" : "bg-stone-100"
              }`}
            >
              {m.content}
            </p>
          </div>
        ))}
        {pending && <p className="text-xs text-muted">Assistant is thinking…</p>}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="mt-3 flex gap-2">
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='e.g. "Saturday night only, under $40, no spicy"'
          maxLength={1000}
          aria-label="Message your assistant"
        />
        <button className="btn" disabled={pending || !text.trim()}>Send</button>
      </form>

      <div className="mt-4 rounded-xl bg-stone-50 p-3 text-sm">
        <div className="mb-1 font-medium">What your assistant knows</div>
        {summary.length ? (
          <ul className="list-inside list-disc text-muted">{summary.map((s) => <li key={s}>{s}</li>)}</ul>
        ) : (
          <p className="text-muted">Nothing yet.</p>
        )}
        <div className="mt-3 flex items-center justify-between gap-2">
          <span className="text-xs text-muted">
            {missing.length ? `Still needs: ${missing.map((m) => MISSING_LABEL[m]).join(", ")}` : "All set ✓"}
          </span>
          <button
            onClick={toggleReady}
            disabled={pending || (!ready && missing.length > 0)}
            className={ready ? "btn-ghost" : "btn"}
          >
            {ready ? "Not done yet" : "I'm done"}
          </button>
        </div>
      </div>
      {error && <p role="alert" className="mt-2 text-sm text-red-600">{error}</p>}
    </section>
  );
}
