import { redirect } from "next/navigation";
import { AuthForm } from "@/components/AuthForm";
import { currentUser } from "@/lib/session";
import { loginAction } from "../actions";

export const metadata = { title: "Log in — Settle" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next = "/" } = await searchParams;
  if (await currentUser()) redirect(next.startsWith("/") ? next : "/");
  return <AuthForm mode="login" action={loginAction} next={next} />;
}
