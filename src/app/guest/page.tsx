import { redirect } from "next/navigation";
import { GuestForm } from "@/components/GuestForm";
import { planCodeFrom } from "@/lib/plan-code";
import { currentUser } from "@/lib/session";

export const metadata = { title: "Continue as a guest — Settle" };

export default async function GuestPage({ searchParams }: { searchParams: Promise<{ code?: string }> }) {
  const code = planCodeFrom((await searchParams).code);
  // Someone already signed in has no use for this page: the plan itself asks them to join.
  if (await currentUser()) redirect(code ? `/e/${code}` : "/");
  return <GuestForm code={code} />;
}
