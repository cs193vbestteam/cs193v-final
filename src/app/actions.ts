"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { AuthError, authenticate, createUser } from "@/lib/auth";
import { describeConstraints, missingFields, type MissingField } from "@/lib/constraints";
import type { ChatTurn } from "@/lib/extract";
import { AccessError, createEvent, joinEvent, runNegotiation, sendMessage, setReady } from "@/lib/events";
import { endSession, requireUser, startSession } from "@/lib/session";
import { safeNext } from "@/lib/redirect";

export type FormState = { error?: string };

function friendly(err: unknown): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Invalid input";
  if (err instanceof AuthError || err instanceof AccessError) return err.message;
  console.error(err);
  return "Something went wrong. Please try again.";
}

export async function signupAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    const user = await createUser({
      email: String(form.get("email") ?? ""),
      displayName: String(form.get("displayName") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    await startSession(user.id);
  } catch (err) {
    return { error: friendly(err) };
  }
  redirect(safeNext(form.get("next")));
}

export async function loginAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    const user = await authenticate({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    await startSession(user.id);
  } catch (err) {
    return { error: friendly(err) };
  }
  redirect(safeNext(form.get("next")));
}

export async function logoutAction() {
  await endSession();
  redirect("/login");
}

export async function createEventAction(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  let code: string;
  try {
    code = (await createEvent(user.id, String(form.get("title") ?? ""), String(form.get("location") ?? ""))).inviteCode;
  } catch (err) {
    return { error: friendly(err) };
  }
  redirect(`/e/${code}`);
}

export async function joinEventAction(code: string) {
  const user = await requireUser(`/e/${code}`);
  await joinEvent(code, user.id);
  revalidatePath(`/e/${code}`);
}

export type ChatState = {
  messages: ChatTurn[];
  summary: string[];
  missing: MissingField[];
  error?: string;
};

export async function sendMessageAction(eventId: string, inviteCode: string, text: string): Promise<ChatState | { error: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    const { messages, constraints } = await sendMessage(eventId, user.id, text);
    revalidatePath(`/e/${inviteCode}`);
    return { messages, summary: describeConstraints(constraints), missing: missingFields(constraints) };
  } catch (err) {
    return { error: friendly(err) };
  }
}

export async function setReadyAction(eventId: string, inviteCode: string, ready: boolean): Promise<{ error?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    await setReady(eventId, user.id, ready);
  } catch (err) {
    return { error: friendly(err) };
  }
  revalidatePath(`/e/${inviteCode}`);
  return {};
}

export async function runNegotiationAction(eventId: string, inviteCode: string): Promise<{ error?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    await runNegotiation(eventId, user.id);
  } catch (err) {
    return { error: friendly(err) };
  }
  revalidatePath(`/e/${inviteCode}`);
  return {};
}
