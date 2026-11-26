import { InfoTip } from "@/components/InfoTip";
import Link from "next/link";
import { Avatar } from "@/components/Avatar";
import { DeleteAccountForm } from "@/components/DangerActions";
import { avatarFor } from "@/lib/avatar";
import { requireUser } from "@/lib/session";

export const metadata = { title: "Account — Settle" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  return (
    <div className="mx-auto mt-8 max-w-2xl sm:mt-14">
      <p className="eyebrow rise">Account</p>
      <h1
        className="display rise mt-3 flex items-center gap-4 text-4xl sm:text-5xl"
        style={{ "--d": "0.06s" } as React.CSSProperties}
      >
        <Avatar name={avatarFor(user.id)} size={56} />
        <span className="min-w-0 truncate">{user.displayName}</span>
      </h1>

      <section className="card rise mt-8" style={{ "--d": "0.12s" } as React.CSSProperties}>
        <h2 className="font-serif text-xl">Your details</h2>
        <dl className="mt-3 divide-y divide-line text-sm">
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="text-ink-2">Name your friends see</dt>
            <dd className="truncate text-ink">{user.displayName}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 py-2.5">
            <dt className="flex items-center gap-1 text-ink-2">
              Email
              <InfoTip label="About your email">
                {user.guest
                  ? "A guest stays signed in on this browser only. Nothing here can be opened from another device."
                  : "Stored encrypted and never shown to the people you plan with."}
              </InfoTip>
            </dt>
            <dd className="truncate text-ink">{user.guest ? "None (guest)" : user.email}</dd>
          </div>
        </dl>
      </section>

      {user.guest && (
        <section data-arrive className="card mt-5">
          <h2 className="font-serif text-xl">Keep your plans</h2>
          <p className="mt-2 text-sm text-ink-2">Open your plans from any device and start your own.</p>
          <Link href="/signup" className="btn btn-sm mt-4">
            Add email and password
          </Link>
        </section>
      )}

      <section data-arrive className="card mt-5">
        <h2 className="font-serif text-xl">Delete account</h2>
        <p className="mt-2 text-sm text-ink-2">Removes everything Settle stores about you.</p>
        <div className="mt-4">
          <DeleteAccountForm />
        </div>
      </section>
    </div>
  );
}
