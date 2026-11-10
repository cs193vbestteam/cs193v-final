import Link from "next/link";
import { DeleteAccountForm } from "@/components/DangerActions";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Account — Settle" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  return (
    <div className="mx-auto mt-8 max-w-2xl sm:mt-14">
      <p className="eyebrow rise">Account</p>
      <h1 className="display rise mt-3 text-4xl sm:text-5xl" style={{ "--d": "0.06s" } as React.CSSProperties}>
        {user.displayName}
      </h1>

      <section className="card rise mt-8" style={{ "--d": "0.12s" } as React.CSSProperties}>
        <h2 className="font-serif text-xl">Your details</h2>
        <dl className="mt-3 divide-y divide-line text-sm">
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-ink-2">Name your friends see</dt>
            <dd className="truncate text-ink">{user.displayName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-ink-2">Email</dt>
            <dd className="truncate text-ink">{user.email}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-ink-3">
          Your email is stored encrypted and is never shown to the people you plan with.
        </p>
      </section>

      <section className="card rise mt-5" style={{ "--d": "0.18s" } as React.CSSProperties}>
        <h2 className="font-serif text-xl">Delete account</h2>
        <p className="mt-2 text-sm text-ink-2">
          Removes everything Settle stores about you. To leave a single plan instead, open it from{" "}
          <Link className="link text-ink" href="/">
            your plans
          </Link>
          .
        </p>
        <div className="mt-4">
          <DeleteAccountForm />
        </div>
      </section>
    </div>
  );
}
