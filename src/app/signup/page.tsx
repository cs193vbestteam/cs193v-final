import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { currentUser } from "@/lib/session";
import { signupAction } from "../actions";

export const metadata = { title: "Sign up — Settle" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next = "/" } = await searchParams;
  const user = await currentUser();
  // A guest comes here to keep their plans; anyone else who is signed in has nothing to do here.
  if (user && !user.guest) redirect(next.startsWith("/") ? next : "/");
  return <AuthForm mode="signup" action={signupAction} next={next} guestName={user?.displayName} />;
}
