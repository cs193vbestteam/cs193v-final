"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { headers } from "next/headers";
import { AuthError, authenticate, checkIpLimit, createUser } from "@/lib/auth";
import type { MissingField } from "@/lib/constraints";
import type { AnswerStep } from "@/lib/member-state";
import type { ChatTurn } from "@/lib/extract";
import {
  AccessError,
  DEFAULT_PLAN_SIZE,
  PlanSizeSchema,
  createEvent,
  deleteAccount,
  deletePlan,
  joinEvent,
  leavePlan,
  negotiateWhenAllReady,
  removeMember,
  resetInviteCode,
  runNegotiation,
  sendMessage,
  setMaxMembers,
  setReady,
} from "@/lib/events";
import { planDateSchema } from "@/lib/plan-date";
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
    // The form always sends a date; a request without one is refused here rather than defaulted.
    const date = planDateSchema().parse(String(form.get("date") ?? ""));
    code = (
      await createEvent(
        user.id,
        String(form.get("title") ?? ""),
        String(form.get("location") ?? ""),
        scenario,
        date,
        PlanSizeSchema.parse(form.get("maxMembers") ?? DEFAULT_PLAN_SIZE),
      )
    ).inviteCode;
  } catch (err) {
    return { error: friendly(err) };
  }
  redirect(`/e/${code}`);
}

export async function joinEventAction(code: string) {
  const user = await requireUser(`/e/${code}`);
  try {
    await joinEvent(code, user.id);
  } catch (err) {
    // A full plan or a replaced link: the page itself says which, so show it again rather than an error screen.
    if (!(err instanceof AccessError)) throw err;
  }
  revalidatePath(`/e/${code}`);
}

export type ChatState = {
  messages: ChatTurn[];
  summary: string[];
  missing: MissingField[];
  progress: AnswerStep[];
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
    const { describeConstraints, missingFields, answerProgress } = scenarioFor(scenario);
    return {
      messages,
      summary: describeConstraints(constraints),
      missing: missingFields(constraints),
      progress: answerProgress(constraints),
    };
  } catch (err) {
    return { error: friendly(err) };
  }
}

/** Shown to the person whose "I'm done" should have started the negotiation, when it could not. */
const AUTO_FAILED =
  "You're marked done, but the plan couldn't be found automatically. Press \"Find a plan\" to try again.";

export async function setReadyAction(
  eventId: string,
  inviteCode: string,
  ready: boolean,
): Promise<{ error?: string; notice?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    await setReady(eventId, user.id, ready);
  } catch (err) {
    return { error: friendly(err) };
  }
  // The last person to finish starts the negotiation. If that fails, being done still
  // stands, and the person is told to use the "Find a plan" button.
  let notice: string | undefined;
  if (ready) {
    try {
      await negotiateWhenAllReady(eventId, user.id);
    } catch (err) {
      console.error("Automatic negotiation failed:", (err as Error).message);
      notice = AUTO_FAILED;
    }
  }
  revalidatePath(`/e/${inviteCode}`);
  return notice ? { notice } : {};
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

/** Creator only (checked in removeMember). Takes someone else out of the plan, with their chat and constraints. */
export async function removeMemberAction(
  eventId: string,
  inviteCode: string,
  memberId: string,
): Promise<{ error?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    await removeMember(eventId, user.id, memberId);
  } catch (err) {
    return { error: friendly(err) };
  }
  revalidatePath(`/e/${inviteCode}`);
  return {};
}

/** Creator only (checked in resetInviteCode). The old link stops working and the page moves to the new one. */
export async function resetInviteAction(eventId: string, inviteCode: string): Promise<{ error?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  let code: string;
  try {
    code = await resetInviteCode(eventId, user.id);
  } catch (err) {
    return { error: friendly(err) };
  }
  revalidatePath("/");
  redirect(`/e/${code}`);
}

/** Creator only (checked in setMaxMembers). Changes how many people fit in the plan. */
export async function setMaxMembersAction(
  eventId: string,
  inviteCode: string,
  maxMembers: number,
): Promise<{ error?: string }> {
  const user = await requireUser(`/e/${inviteCode}`);
  try {
    await setMaxMembers(eventId, user.id, maxMembers);
  } catch (err) {
    return { error: friendly(err) };
  }
  revalidatePath(`/e/${inviteCode}`);
  return {};
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
