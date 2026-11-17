import Link from "next/link";

export const metadata = { title: "Privacy — Settle" };

/**
 * What happens to what people tell Settle (#111). The text follows AI-CONSENT.md, which records
 * what we found in Anthropic's policies; when that file changes, this page changes with it.
 * Public, so someone can read it before signing up.
 */

const POLICIES = {
  training: "https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training",
  retention: "https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data",
  api: "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
};

function Outside({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="link" href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line pt-8">
      <h2 className="font-serif text-2xl leading-tight sm:text-[1.75rem]">{title}</h2>
      <div className="mt-3 space-y-3 text-[0.9375rem] leading-relaxed text-ink-2">{children}</div>
    </section>
  );
}

function List({ items }: { items: React.ReactNode[] }) {
  return (
    <ul className="space-y-1.5">
      {items.map((item, i) => (
        <li key={i} className="flex gap-2.5">
          <span aria-hidden className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-ink-3" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function PrivacyPage() {
  return (
    <div className="mx-auto mt-10 max-w-2xl sm:mt-16">
      <p className="eyebrow">Privacy</p>
      <h1 className="display mt-3 text-4xl sm:text-5xl">
        What happens to what you <em>tell us</em>.
      </h1>
      <p className="lede mt-5">
        Your group sees the plan, not your chat. An AI model reads your chat to turn it into preferences, and a program
        on our server uses everyone&apos;s preferences to pick the place and time.
      </p>

      <div className="mt-10 space-y-8">
        <Section title="What your group sees">
          <List
            items={[
              "The plan: the place, the time, and up to five other places that work.",
              "With three or more people, how many can come. Never who cannot, and never why.",
              "With two people, no count at all, because it would be the other person's answer.",
              "Everyone's name, and whether they are done talking to their assistant.",
            ]}
          />
          <p>
            They never see your chat, your budget, when you are free, what you will not eat, or how far you will go.
          </p>
        </Section>

        <Section title="What the AI reads">
          <p>
            Your private chat is read by Claude, an AI model made by Anthropic. Each time you send a message, we send
            Anthropic:
          </p>
          <List
            items={[
              "Up to 20 of the most recent messages in your chat.",
              "The preferences already noted for you: budget, when you are free, diet, allergy notes, and restaurants you named.",
              "Our instructions to the assistant.",
            ]}
          />
          <p>
            We do not add your name, your email, your account, the invite link, or anything about the other people in
            the plan. But anything personal you type into the chat is sent as you typed it.
          </p>
          <p>The AI only reads your chat. It does not choose the plan: a program does that, with no AI involved.</p>
        </Section>

        <Section title="What Anthropic does with it">
          <List
            items={[
              <>
                It does not use what we send to train its models by default. Sending feedback to Anthropic can allow
                that, and Settle has no way to send any. <Outside href={POLICIES.training}>Training policy</Outside>
              </>,
              <>
                Its standard policy is to delete what we send within 30 days. Content flagged for breaking its rules can
                be kept for up to two years, safety scores for up to seven, and it keeps what the law requires.{" "}
                <Outside href={POLICIES.retention}>Retention policy</Outside>
              </>,
              <>
                We use the standard service, without an agreement for Anthropic to keep nothing. So we do not promise
                that your messages are deleted there straight away.{" "}
                <Outside href={POLICIES.api}>How the API handles data</Outside>
              </>,
            ]}
          />
        </Section>

        <Section title="Places and starting points">
          <p>
            The area a plan&apos;s creator types in is sent to Google Places to find restaurants. Once everyone is done,
            Google is also asked for the kinds of food and the diets the group mentioned, near that area. It is not told
            who asked for what, or how many people did.
          </p>
          <p>
            If you tell your assistant where you are coming from, that text is sent to Google Places to find it on the
            map. None of this is sent to an AI.
          </p>
        </Section>

        <Section title="What Settle keeps">
          <p>
            Your chats and preferences are stored encrypted in our database. Our server can decrypt them: it has to, to
            show you your own chat and to work out the plan. Your password is never stored, only a one-way fingerprint
            of it.
          </p>
          <p>Nothing is deleted automatically yet. You can delete it yourself:</p>
          <List
            items={[
              "Leave a plan, and your chat and preferences for that plan are removed.",
              "Delete a plan you created, and everyone's chats for it go with it.",
              <>
                Delete your account on the{" "}
                <Link href="/account" className="link">
                  account page
                </Link>
                , and everything stored about you is removed.
              </>,
            ]}
          />
        </Section>

        <Section title="What you cannot choose yet">
          <p>
            There is no way to use Settle without the AI reading your chat. If the AI is unavailable, a simpler reader
            made of fixed rules answers instead, but that is a fallback, not a setting you can pick.
          </p>
        </Section>
      </div>

      <div className="mt-12">
        <Link href="/" className="btn-ghost">
          Back to Settle
        </Link>
      </div>
    </div>
  );
}
