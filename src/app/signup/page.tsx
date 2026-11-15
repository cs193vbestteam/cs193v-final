import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { currentUser } from "@/lib/session";
import { signupAction } from "../actions";

export const metadata = { title: "Sign up — Settle" };

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next = "/" } = await searchParams;
  if (await currentUser()) redirect(next.startsWith("/") ? next : "/");
  return <AuthForm mode="signup" action={signupAction} next={next} />;
}
