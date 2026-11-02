import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createSession, deleteSession, getUserBySession, type User } from "./auth";

const COOKIE = "tacit_session";

export async function startSession(userId: string) {
  const { token, expiresAt } = await createSession(userId);
  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    expires: new Date(expiresAt),
  });
}

export async function endSession() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await deleteSession(token);
  jar.delete(COOKIE);
}

export async function currentUser(): Promise<User | null> {
  return getUserBySession((await cookies()).get(COOKIE)?.value);
}

export async function requireUser(nextPath = "/"): Promise<User> {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return user;
}
