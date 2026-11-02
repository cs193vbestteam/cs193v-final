import Link from "next/link";

/** The Tacit wordmark: a serif italic with the seal-coloured full stop. */
export function Wordmark({ className = "" }: { className?: string }) {
  return (
    <Link href="/" aria-label="Tacit home" className={`group inline-flex items-baseline gap-0.5 ${className}`}>
      <span className="font-serif text-[1.65rem] italic leading-none tracking-tight text-ink">tacit</span>
      <span
        aria-hidden
        className="mb-[1px] inline-block h-[0.42rem] w-[0.42rem] rounded-full bg-seal transition-transform duration-500 ease-out group-hover:scale-150"
      />
    </Link>
  );
}
