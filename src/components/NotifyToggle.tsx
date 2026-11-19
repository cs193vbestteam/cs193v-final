"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

/**
 * "Notify me when the plan is ready." A person who has finished their part should not have to
 * keep the tab in front to find out. The choice is kept in this browser only, per plan; nothing
 * is sent to the server, and the notification says only that the plan is ready and its name.
 * It works while the page is open in a tab, because that is what notices the plan arriving.
 */

const key = (eventId: string) => `settle-notify:${eventId}`;
const CHANGED = "settle-notify-changed";

function read(eventId: string): boolean {
  try {
    return window.localStorage.getItem(key(eventId)) === "1";
  } catch {
    return false;
  }
}
function write(eventId: string, on: boolean) {
  try {
    if (on) window.localStorage.setItem(key(eventId), "1");
    else window.localStorage.removeItem(key(eventId));
  } catch {
    // Storage can be switched off; the toggle then lasts only as long as the page does.
  }
  window.dispatchEvent(new Event(CHANGED));
}
function subscribe(onChange: () => void) {
  window.addEventListener(CHANGED, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(CHANGED, onChange);
    window.removeEventListener("storage", onChange);
  };
}

const supported = () => typeof window !== "undefined" && "Notification" in window;

export function NotifyToggle({ eventId }: { eventId: string }) {
  const on = useSyncExternalStore(
    subscribe,
    () => read(eventId) && supported() && Notification.permission === "granted",
    () => false,
  );
  const [note, setNote] = useState<string | null>(null);
  // Counts presses that turn it on, so the bell rings again each time.
  const [rings, setRings] = useState(0);

  async function toggle() {
    setNote(null);
    if (on) return write(eventId, false);
    if (!supported()) return setNote("This browser can't show notifications. Keep this tab open instead.");
    const permission =
      Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    if (permission !== "granted")
      return setNote("Notifications are blocked for this site. Allow them in your browser's settings, then try again.");
    setRings((n) => n + 1);
    write(eventId, true);
  }

  return (
    <div>
      <button type="button" className="bell-toggle" aria-pressed={on} onClick={toggle}>
        <svg
          key={rings}
          aria-hidden
          className="bell"
          data-ring={rings > 0 || undefined}
          viewBox="0 0 20 20"
          width="18"
          height="18"
        >
          <path d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5c0 4-1.75 5.25-1.75 5.25h12.5S14.5 11 14.5 7A4.5 4.5 0 0 0 10 2.5Z" />
          <path d="M8.4 15.5a1.7 1.7 0 0 0 3.2 0" />
        </svg>
        <span className="bell-toggle-labels">
          <span data-show={!on || undefined}>Notify me when it&apos;s ready</span>
          <span data-show={on || undefined}>You&apos;ll be notified</span>
        </span>
      </button>
      <p className="mt-2 text-xs text-ink-3" role={note ? "alert" : undefined}>
        {note ??
          (on
            ? "Keep this page open in a tab. It can be in the background."
            : "Works while this page stays open in a tab.")}
      </p>
    </div>
  );
}

/**
 * Sits on the plan page whether or not there is a plan yet, and tells the person once when one
 * appears, if they asked to be told. A plan that was already there when the page loaded is not news.
 */
export function PlanReadyWatcher({ eventId, title, ready }: { eventId: string; title: string; ready: boolean }) {
  const was = useRef(ready);
  useEffect(() => {
    const arrived = ready && !was.current;
    was.current = ready;
    if (!arrived || !read(eventId)) return;
    write(eventId, false);
    if (!supported() || Notification.permission !== "granted") return;
    try {
      const n = new Notification("The plan is ready", { body: title, tag: key(eventId) });
      n.onclick = () => {
        window.focus();
        n.close();
      };
    } catch {
      // Some browsers only allow notifications from a service worker. The page itself still shows the plan.
    }
  }, [ready, eventId, title]);
  return null;
}
