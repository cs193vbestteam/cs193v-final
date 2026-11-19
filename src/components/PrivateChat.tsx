"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { sendMessageAction, setReadyAction } from "@/app/actions";
import { MAX_MESSAGE_CHARS, MESSAGE_HINT_FROM } from "@/lib/chat-limits";
import type { MissingField } from "@/lib/constraints";
import type { ChatTurn } from "@/lib/extract";
import type { AnswerStep } from "@/lib/member-state";
import { AnswerDial } from "./AnswerDial";

type Props = {
  eventId: string;
  inviteCode: string;
  initialMessages: ChatTurn[];
  initialSummary: string[];
  initialMissing: MissingField[];
  /** The questions and which are answered, for the progress bar. Left out, no bar is drawn. */
  initialProgress?: AnswerStep[];
  ready: boolean;
  /** Everyone else is done and there is no plan yet: finishing here starts the negotiation. */
  lastOne?: boolean;
  /**
   * For someone who is done: what happens now, and where to go for it (#153). A tester pressed
   * "I'm done" and could not tell whether they were finished or what the group was waiting for.
   */
  next?: { text: string; href?: string; link?: string } | null;
};

const MISSING_LABEL: Record<MissingField, string> = {
  time: "when",
  budget: "budget",
  distance: "distance",
  diet: "what you can't eat",
};

type ChatSnapshot = {
  eventId: string;
  messages: ChatTurn[];
  summary: string[];
  missing: MissingField[];
  progress: AnswerStep[];
};

const NO_PROGRESS: AnswerStep[] = [];

/** Ready-made answers for the question a person has not answered yet. A tap adds one to the message box. */
const QUICK: Record<AnswerStep["topic"], string[]> = {
  time: ["Dinner after 7", "Lunch", "Any time works"],
  budget: ["Around $30", "Up to $50", "No budget limit"],
  travel: ["15 minutes at most", "30 minutes at most", "Any distance"],
  diet: ["Nothing I can't eat", "Vegetarian", "No spicy food"],
  cuisine: ["Thai", "Japanese", "No preference on food"],
};

export function PrivateChat({
  eventId,
  inviteCode,
  initialMessages,
  initialSummary,
  initialMissing,
  initialProgress = NO_PROGRESS,
  ready,
  lastOne = false,
  next = null,
}: Props) {
  const [finding, setFinding] = useState(false);
  const [localReply, setLocalReply] = useState<ChatSnapshot | null>(null);
  const [submission, setSubmission] = useState<ChatSnapshot | null>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const bottom = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const serverSnapshot: ChatSnapshot = {
    eventId,
    messages: initialMessages,
    summary: initialSummary,
    missing: initialMissing,
    progress: initialProgress,
  };
  // Chats are append-only. Keep a completed send until server props catch up,
  // then render refreshed props directly instead of copying them into state.
  const latest =
    localReply?.eventId === eventId && localReply.messages.length > initialMessages.length
      ? localReply
      : serverSnapshot;
  // A refresh during a send must not erase its optimistic message or draft.
  const { messages, summary, missing, progress } = submission?.eventId === eventId ? submission : latest;

  // The assistant has asked them to click "I'm done": draw the eye to it until they do.
  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant")?.content ?? "";
  const askedToFinish = !ready && missing.length === 0 && /\bI['’]m done\b/i.test(lastAssistant);

  const answered = progress.filter((s) => s.done).length;
  // The needed questions come first, then the optional ones, in the order the assistant asks them.
  const nextStep = progress.find((s) => !s.done && s.required) ?? progress.find((s) => !s.done);

  function addQuick(answer: string) {
    setText((draft) => (draft.trim() ? `${draft.trim().replace(/[,.]$/, "")}, ${answer.toLowerCase()}` : answer));
    input.current?.focus();
  }

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    const msg = text.trim();
    if (!msg || pending) return;
    setText("");
    setError(null);
    setSubmission({ eventId, messages: [...messages, { role: "user", content: msg }], summary, missing, progress });
    startTransition(async () => {
      try {
        const res = await sendMessageAction(eventId, inviteCode, msg);
        if ("messages" in res) {
          setLocalReply({
            eventId,
            messages: res.messages,
            summary: res.summary,
            missing: res.missing,
            progress: res.progress,
          });
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
        // "Change my answers" leads straight back to the conversation.
        else if (ready) input.current?.focus();
      } catch {
        setError("Couldn't save that. Please try again.");
      } finally {
        setFinding(false);
      }
    });
  }

  return (
    <section className="card flex flex-col !p-0 lg:h-[min(42rem,calc(100dvh-14rem))] lg:min-h-[30rem]">
      <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="font-serif text-xl">Your private assistant</h2>
        <span className="pill shrink-0">
          <LockIcon />
          <span className="sm:hidden">private</span>
          <span className="hidden sm:inline">hidden from your group</span>
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
          <div
            key={i}
            className={`bubble-in flex items-end gap-2 ${m.role === "user" ? "justify-end" : "justify-start"}`}
          >
            {/* The assistant's mark, on the first of its messages in a row. */}
            {m.role === "assistant" && (
              <span aria-hidden className="chat-mark" data-quiet={messages[i - 1]?.role === "assistant" || undefined}>
                <LockIcon />
              </span>
            )}
            <p
              className={`max-w-[85%] whitespace-pre-wrap text-[0.9375rem] leading-relaxed ${
                m.role === "user"
                  ? "bubble-mine rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-paper"
                  : "bubble-theirs rounded-2xl rounded-bl-md bg-paper-2 px-3.5 py-2 text-ink"
              }`}
            >
              {m.content}
            </p>
          </div>
        ))}
        {pending && (
          <p className="flex items-center gap-2.5 pl-9 text-xs text-ink-3">
            {finding ? (
              <span aria-hidden className="lattice">
                {Array.from({ length: 9 }, (_, k) => (
                  <i key={k} style={{ "--i": (k % 3) + Math.floor(k / 3) } as React.CSSProperties} />
                ))}
              </span>
            ) : (
              <svg aria-hidden className="thought-line" viewBox="0 0 44 12" width="44" height="12">
                <path d="M1 6 Q 6.25 0 11.5 6 T 22 6 T 32.5 6 T 43 6" pathLength={1} />
              </svg>
            )}
            <span className="shiny">{finding ? "Everyone's done. Finding a plan…" : "Assistant is thinking…"}</span>
          </p>
        )}
        <div ref={bottom} />
      </div>

      {/* Where the conversation ends: what is still missing, the way to finish, and what happens after. */}
      <div className={`border-t px-5 py-3 ${ready ? "border-moss/30 bg-moss-soft" : "border-line"}`}>
        {/* How far through the questions they are, so nobody has to guess whether they have finished. */}
        {!ready && progress.length > 0 && (
          <div className="mb-3 flex items-center gap-4">
            <AnswerDial progress={progress} />
            <div className="min-w-0 flex-1">
              <p className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">
                <span id="answers-label" className="sr-only">
                  Your answers
                </span>
                {answered} of {progress.length} answered
              </p>
              <ol aria-labelledby="answers-label" className="mt-2 flex flex-wrap gap-1.5">
                {progress.map((s) => (
                  <li
                    key={s.topic}
                    className="answer-chip"
                    data-done={s.done || undefined}
                    data-needed={(!s.done && s.required) || undefined}
                  >
                    {s.done && (
                      <span aria-hidden className="answer-chip-check">
                        ✓{" "}
                      </span>
                    )}
                    {s.label}
                    <span className="sr-only">
                      {s.done
                        ? ": answered"
                        : s.required
                          ? ": needed before you can finish"
                          : ": optional, not answered"}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {ready ? (
            <p role="status" className="min-w-0 flex-1 basis-64 text-sm text-ink-2">
              <svg aria-hidden className="status-mark" viewBox="0 0 20 20" width="20" height="20">
                <circle cx="10" cy="10" r="8.5" pathLength={1} />
                <path d="M6 10.4 8.8 13 14 7.4" pathLength={1} />
              </svg>{" "}
              <strong className="font-medium text-moss">Your part is done.</strong>
              {next && (
                <>
                  {" "}
                  {next.text}
                  {next.href && next.link && (
                    <>
                      {" "}
                      <a href={next.href} className="link">
                        {next.link}
                      </a>
                    </>
                  )}
                </>
              )}
            </p>
          ) : (
            <span
              className={`font-mono text-[0.75rem] uppercase tracking-wider ${missing.length ? "text-ink-3" : "text-moss"}`}
            >
              {missing.length
                ? `Still needs: ${missing.map((m) => MISSING_LABEL[m]).join(", ")}`
                : answered < progress.length
                  ? "All set ✓ The rest is optional"
                  : "All set ✓"}
            </span>
          )}
          <button
            type="button"
            onClick={toggleReady}
            disabled={pending || (!ready && missing.length > 0)}
            className={ready ? "btn-ghost btn-sm" : `btn btn-sm${askedToFinish ? " btn-attention" : ""}`}
            data-attention={askedToFinish || undefined}
          >
            {finding ? "Finding a plan…" : ready ? "Change my answers" : "I'm done"}
          </button>
        </div>
      </div>

      <div className="border-t border-line px-4 py-3">
        {/* A head start on the next unanswered question. Nothing is sent until they press Send. */}
        {!ready && nextStep && (
          <div className="mb-2.5 flex flex-wrap items-center gap-1.5" role="group" aria-label="Quick answers">
            <span className="font-mono text-[0.75rem] uppercase tracking-wider text-ink-3">{nextStep.label}?</span>
            {QUICK[nextStep.topic].map((answer) => (
              <button key={answer} type="button" className="quick-chip" onClick={() => addQuick(answer)}>
                {answer}
              </button>
            ))}
          </div>
        )}
        <form onSubmit={send} className="prompt-bar" data-busy={pending || undefined}>
          <input
            ref={input}
            className="prompt-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder='Try: "dinner after 7, around $30, vegetarian"'
            maxLength={MAX_MESSAGE_CHARS}
            aria-label="Message your assistant"
            aria-describedby={text.length >= MESSAGE_HINT_FROM ? "message-room" : undefined}
            autoComplete="off"
          />
          <button className="prompt-send" disabled={pending || !text.trim()}>
            <span className="sr-only">Send</span>
            <svg aria-hidden viewBox="0 0 16 16" width="16" height="16" fill="none">
              <path
                d="M8 13V3M3.5 7.5 8 3l4.5 4.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
      </div>
      {text.length >= MESSAGE_HINT_FROM && (
        <p id="message-room" className="px-4 pb-2 text-xs text-ink-3">
          {MAX_MESSAGE_CHARS - text.length} characters left. Messages are short on purpose.
        </p>
      )}

      {/* The words are AI-CONSENT.md's: what leaves, who gets it, and for how long, said where people type. */}
      <p className="px-4 pb-3 text-xs leading-relaxed text-ink-3">
        Your messages and meal preferences are sent to Anthropic&apos;s Claude. Anthropic does not use API chats for
        training by default. Its standard retention policy is up to 30 days, with longer retention for flagged content
        or legal requirements. Your group sees the plan, not your chat.{" "}
        <a className="link link-small" href="/privacy" target="_blank" rel="noopener">
          How your data is used<span className="sr-only"> (opens in a new tab)</span>
        </a>
      </p>

      <div className="border-t border-line bg-paper-2/40 px-5 py-4">
        <div className="eyebrow">What your assistant knows</div>
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
