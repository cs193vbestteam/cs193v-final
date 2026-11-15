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
  /** Everyone else is done and there is no plan yet: finishing here starts the negotiation. */
  lastOne?: boolean;
};

const MISSING_LABEL: Record<MissingField, string> = {
  time: "when",
  budget: "budget",
  distance: "distance",
  diet: "diet",
};

type ChatSnapshot = {
  eventId: string;
  messages: ChatTurn[];
  summary: string[];
  missing: MissingField[];
};

export function PrivateChat({
  eventId,
  inviteCode,
  initialMessages,
  initialSummary,
  initialMissing,
  ready,
  lastOne = false,
}: Props) {
  const [finding, setFinding] = useState(false);
  const [localReply, setLocalReply] = useState<ChatSnapshot | null>(null);
  const [submission, setSubmission] = useState<ChatSnapshot | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);

  const serverSnapshot: ChatSnapshot = {
    eventId,
    messages: initialMessages,
    summary: initialSummary,
    missing: initialMissing,
  };
  // Chats are append-only. Keep a completed send until server props catch up,
  // then render refreshed props directly instead of copying them into state.
  const latest =
    localReply?.eventId === eventId && localReply.messages.length > initialMessages.length
      ? localReply
      : serverSnapshot;
  // A refresh during a send must not erase its optimistic message or draft.
  const { messages, summary, missing } = submission?.eventId === eventId ? submission : latest;

  // The assistant has asked them to click "I'm done": draw the eye to it until they do.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const askedToFinish = !ready && missing.length === 0 && /\bI['’]m done\b/i.test(lastAssistant);

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
    setFinding(!ready && lastOne);
    startTransition(async () => {
      try {
        const res = await setReadyAction(eventId, inviteCode, !ready);
        // A notice means being done was saved but the automatic run failed: say what to do next.
        if (res.error || res.notice) setError(res.error ?? res.notice ?? null);
      } catch {
        setError("Couldn't save that. Please try again.");
      } finally {
        setFinding(false);
      }
    });
  }

  const progress = 4 - missing.length;

  return (
    <section className="card flex flex-col !p-0 lg:h-[min(42rem,calc(100dvh-14rem))] lg:min-h-[30rem]">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="font-serif text-xl">Your private assistant</h2>
        <span className="pill shrink-0">
          <LockIcon />
          <span className="sm:hidden">private</span>
          <span className="hidden sm:inline">only you can see this</span>
        </span>
      </header>

      <div
        className="scroll-quiet max-h-[26rem] min-h-[16rem] flex-1 space-y-3 overflow-y-auto px-5 py-4 lg:max-h-none lg:min-h-[8rem]"
        role="log"
        aria-label="Conversation with your assistant"
        aria-live="polite"
        tabIndex={0}
      >
        {messages.map((m, i) => (
          <div key={i} className={`bubble-in flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
            <p
              className={`max-w-[85%] whitespace-pre-wrap text-[0.9375rem] leading-relaxed ${
                m.role === "user"
                  ? "rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-paper"
                  : "rounded-2xl rounded-bl-md bg-paper-2 px-3.5 py-2 text-ink"
              }`}
            >
              {m.content}
            </p>
          </div>
        ))}
        {pending && (
          <p className="flex items-center gap-2 text-xs text-ink-3">
            <span className="thinking inline-flex gap-1">
              <span />
              <span />
              <span />
            </span>
            {finding ? "Everyone's done. The assistants are finding a plan…" : "Assistant is thinking…"}
          </p>
        )}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="flex gap-2 border-t border-line px-4 py-3">
        <input
          className="input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='Try: "Saturday night only, under $40, no spicy"'
          maxLength={1000}
          aria-label="Message your assistant"
          autoComplete="off"
        />
        <button className="btn" disabled={pending || !text.trim()}>
          Send
        </button>
      </form>

      <div className="border-t border-line bg-paper-2/40 px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div className="eyebrow">What your assistant knows</div>
          <div
            className="flex shrink-0 items-center gap-1"
            role="img"
            aria-label={`${progress} of 4 essentials covered`}
          >
            {Array.from({ length: 4 }, (_, i) => (
              <span
                key={i}
                aria-hidden
                className={`h-1.5 w-5 rounded-full transition-colors duration-500 ${i < progress ? "bg-ink" : "bg-line-strong"}`}
              />
            ))}
          </div>
        </div>
        {summary.length ? (
          <ul className="mt-2.5 grid gap-x-6 gap-y-1 text-sm text-ink-2 sm:grid-cols-2">
            {summary.map((s) => (
              <li key={s} className="flex gap-2">
                <span aria-hidden className="mt-[0.55em] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
                <span>{s}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2.5 text-sm text-ink-3">Nothing yet. Just talk to it like a friend who keeps secrets.</p>
        )}
        <div className="mt-4 flex items-center justify-between gap-3">
          <span
            className={`font-mono text-[0.75rem] uppercase tracking-wider ${missing.length ? "text-ink-3" : "text-moss"}`}
          >
            {missing.length ? `Still needs: ${missing.map((m) => MISSING_LABEL[m]).join(", ")}` : "All set ✓"}
          </span>
          <button
            onClick={toggleReady}
            disabled={pending || (!ready && missing.length > 0)}
            className={ready ? "btn-ghost btn-sm" : `btn btn-sm${askedToFinish ? " btn-attention" : ""}`}
            data-attention={askedToFinish || undefined}
          >
            {finding ? "Finding a plan…" : ready ? "Not done yet" : "I'm done"}
          </button>
        </div>
        {error && (
          <p role="alert" className="mt-3 text-sm text-seal-ink">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

function LockIcon() {
  return (
    <svg aria-hidden width="11" height="11" viewBox="0 0 16 16" fill="none">
      <rect x="3" y="7" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
