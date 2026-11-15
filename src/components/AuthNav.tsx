"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { safeNext } from "@/lib/redirect";

/**
 * The signed-out header links. Someone who opened an invite link is sent to
 * /login?next=/e/<code>; these links keep that `next`, so signing up from the
 * header still lands on the plan they were invited to.
 */
export function AuthNav() {
  const next = safeNext(useSearchParams().get("next"));
  const suffix = next === "/" ? "" : `?next=${encodeURIComponent(next)}`;
  return (
    <nav className="flex items-center gap-2">
      <Link href={`/login${suffix}`} className="btn-ghost btn-sm">
        Log in
      </Link>
      <Link href={`/signup${suffix}`} className="btn btn-sm">
        Sign up
      </Link>
    </nav>
  );
}
