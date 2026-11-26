import { useId } from "react";

/**
 * A small "i" that opens a short note on hover, focus or tap. For information a few people need:
 * the screen stays quiet for everyone else. The note is the button's description, so a screen
 * reader hears it too.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const id = useId();
  return (
    <span className="tip">
      <button type="button" className="tip-btn" aria-label={label} aria-describedby={id}>
        <svg aria-hidden viewBox="0 0 16 16" width="14" height="14">
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M8 7.2v3.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <circle cx="8" cy="5" r="0.8" fill="currentColor" />
        </svg>
      </button>
      <span role="tooltip" id={id} className="tip-text">
        {children}
      </span>
    </span>
  );
}
