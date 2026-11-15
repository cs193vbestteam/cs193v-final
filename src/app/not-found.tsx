import Link from "next/link";

export const metadata = { title: "Page not found — Settle" };

export default function NotFound() {
  return (
    <div className="mx-auto mt-20 max-w-md text-center">
      <p className="eyebrow rise">404</p>
      <h1 className="display rise mt-4 text-5xl" style={{ "--d": "0.08s" } as React.CSSProperties}>
        Nothing <em>here.</em>
      </h1>
      <p className="lede rise mt-4" style={{ "--d": "0.16s" } as React.CSSProperties}>
        That plan or page doesn&apos;t exist. Check the invite link, or head home.
      </p>
      <div className="rise mt-8" style={{ "--d": "0.24s" } as React.CSSProperties}>
        <Link href="/" className="btn">
          Go home
        </Link>
      </div>
    </div>
  );
}
