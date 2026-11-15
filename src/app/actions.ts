"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { headers } from "next/headers";
import { AuthError, authenticate, checkIpLimit, createUser } from "@/lib/auth";
import type { MissingField } from "@/lib/constraints";
import type { ChatTurn } from "@/lib/extract";
import {
  AccessError,
  createEvent,
  deleteAccount,
  deletePlan,
  joinEvent,
  leavePlan,
  negotiateWhenAllReady,
  runNegotiation,
  sendMessage,
  setReady,
} from "@/lib/events";
import { DEFAULT_SCENARIO, ScenarioIdSchema, scenarioFor } from "@/lib/scenario";
import { endSession, requireUser, startSession } from "@/lib/session";
import { safeNext } from "@/lib/redirect";

export type FormState = { error?: string };

/** The client's IP. On Vercel the first x-forwarded-for entry is set by the platform. */
async function clientIp(): Promise<string> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

function friendly(err: unknown): string {
  if (err instanceof ZodError) return err.issues[0]?.message ?? "Invalid input";
  if (err instanceof AuthError || err instanceof AccessError) return err.message;
  console.error(err);
  return "Something went wrong. Please try again.";
}

export async function signupAction(_: FormState, form: FormData): Promise<FormState> {
  try {
    await checkIpLimit("signup", await clientIp());
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
    await checkIpLimit("login", await clientIp());
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
    const scenario = ScenarioIdSchema.parse(form.get("scenario") ?? DEFAULT_SCENARIO);
    code = (await createEvent(user.id, String(form.get("title") ?? ""), String(form.get("location") ?? ""), scenario))
      .inviteCode;
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

export async function sendMessageAction(
  eventId: string,
  inviteCode: string,
  text: string,
): Promise<ChatState | { error: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    const { messages, constraints, scenario } = await sendMessage(eventId, user.id, text);
    revalidatePath(`/e/${inviteCode}`);
    const { describeConstraints, missingFields } = scenarioFor(scenario);
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
  // The last person to finish starts the negotiation. If that fails, being done still
  // stands and the "Find a plan" button is there to try again.
  if (ready) {
    try {
      await negotiateWhenAllReady(eventId, user.id);
    } catch (err) {
      console.error("Automatic negotiation failed:", (err as Error).message);
    }
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

/** Creator only (checked in deletePlan). Removes the plan with everyone's chats and the result. */
export async function deletePlanAction(eventId: string, inviteCode: string): Promise<{ error?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    await deletePlan(eventId, user.id);
  } catch (err) {
    return { error: friendly(err) };
  }
  revalidatePath("/");
  redirect("/");
}

/** Removes the caller's own constraints and chat from a plan. */
export async function leavePlanAction(eventId: string, inviteCode: string): Promise<{ error?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    await leavePlan(eventId, user.id);
  } catch (err) {
    return { error: friendly(err) };
  }
  revalidatePath("/");
  redirect("/");
}

/** Deletes the caller's account and all their data. Asks for the password again first. */
export async function deleteAccountAction(_: FormState, form: FormData): Promise<FormState> {
  const user = await requireUser();
  try {
    await authenticate({ email: user.email, password: String(form.get("password") ?? "") });
  } catch (err) {
    return { error: err instanceof AuthError ? "That password isn't right" : friendly(err) };
  }
  try {
    await deleteAccount(user.id);
    await endSession();
  } catch (err) {
    return { error: friendly(err) };
  }
  redirect("/signup");
}
