import { notFound } from "next/navigation";
import { runOptimizerDemo, type DemoCase } from "@/lib/optimizer-demo";

export const metadata = { title: "Optimizer demo — Settle" };
// Runs the optimizer on every request, so the page always shows what the code does now.
export const dynamic = "force-dynamic";

const ORDINAL = ["1ST", "2ND", "3RD", "4TH"];

function Score({ value }: { value: number | null }) {
  if (value === null) return <span className="pill pill-seal">out</span>;
  const tone = value >= 0.95 ? "text-moss" : value >= 0.7 ? "text-ink" : "text-amber-ink";
  return <span className={`font-mono text-sm ${tone}`}>{value.toFixed(2)}</span>;
}

function CaseCard({ c }: { c: DemoCase }) {
  const chosen = c.ranking[0];
  return (
    <article className="card p-5 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h3 className="font-serif text-2xl leading-tight">{c.name}</h3>
        <span className={`pill ${c.matchesRecorded ? "pill-moss" : "pill-amber"}`}>
          {c.matchesRecorded ? "Matches the recorded test" : "Differs from the recorded test"}
        </span>
      </div>
      <p className="mt-2 max-w-3xl text-sm text-ink-2">{c.about}</p>

      <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {c.people.map((p) => (
          <div key={p.id} className="rounded-lg border border-line bg-paper/60 p-3">
            <p className="font-mono text-xs tracking-wider text-ink-3">
              {p.id.toUpperCase()}
              {p.finished !== undefined && (
                <span className="ml-2 text-seal-ink">FINISHED {ORDINAL[p.finished - 1] ?? `#${p.finished}`}</span>
              )}
            </p>
            <ul className="mt-1.5 space-y-1 text-sm text-ink-2">
              {p.said.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      {chosen ? (
        <>
          <p className="mt-6 text-sm text-ink-2">
            <span className="font-medium text-ink">Chosen:</span> {chosen.place} at {chosen.startTime}.{" "}
            {chosen.cannotCome === 0 ? "Everyone can come." : `${chosen.cannotCome} of ${c.people.length} cannot come.`}{" "}
            <span className="text-ink-3">Picked from {c.options.toLocaleString("en-US")} place-and-time options.</span>
          </p>
          <div className="scroll-quiet mt-3 overflow-x-auto">
            <table className="w-full min-w-[640px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-line-strong font-mono text-xs tracking-wider text-ink-3">
                  <th className="py-2 pr-3 font-normal">#</th>
                  <th className="py-2 pr-3 font-normal">PLACE</th>
                  <th className="py-2 pr-3 font-normal">KIND</th>
                  <th className="py-2 pr-3 font-normal">PRICE</th>
                  <th className="py-2 pr-3 font-normal">START</th>
                  <th className="py-2 pr-3 font-normal">CANNOT COME</th>
                  {c.people.map((p) => (
                    <th key={p.id} className="py-2 pr-3 font-normal">
                      {p.id.toUpperCase()}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {c.ranking.map((o, i) => (
                  <tr key={o.key} className={`border-b border-line ${i === 0 ? "bg-moss-soft/50" : ""}`}>
                    <td className="py-2 pr-3 font-mono text-xs text-ink-3">{i + 1}</td>
                    <td className="py-2 pr-3 font-medium text-ink">{o.place}</td>
                    <td className="py-2 pr-3 text-ink-2">{o.kind}</td>
                    <td className="py-2 pr-3 text-ink-2">{o.price}</td>
                    <td className="py-2 pr-3 text-ink-2">
                      <span className="font-mono">{o.startTime}</span>
                      {o.alsoAt.length > 0 && (
                        <span className="ml-2 text-xs text-ink-3">also {o.alsoAt.join(", ")}</span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-ink-2">{o.cannotCome}</td>
                    {o.scores.map((s, j) => (
                      <td key={c.people[j].id} className="py-2 pr-3">
                        <Score value={s} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <p className="mt-6 text-sm text-ink-2">No plan: nothing in the pool is open.</p>
      )}
    </article>
  );
}

export default function OptimizerDemoPage() {
  // Made-up people's preferences side by side: for a developer's own machine, never a deployment.
  if (process.env.NODE_ENV === "production") notFound();
  const areas = runOptimizerDemo();
  const anonymous = areas.some((a) => !a.realNames);

  return (
    <div className="mt-12">
      <p className="eyebrow">Local demo · made-up people · no model involved</p>
      <h1 className="display mt-4 text-5xl">
        The optimizer, <em>nine groups.</em>
      </h1>
      <p className="lede mt-4 max-w-3xl">
        Three areas with restaurants from Google Places, three groups of three or four people in each, for dinner on
        Saturday 21 November 2026. The first row of each table is the plan; the rows under it are the alternatives, best
        first. Every row is a different restaurant at its best start time, with the other times it could take beside it.
        A score is how well the plan suits one person, from 0 to 1; &ldquo;out&rdquo; means a diet, a time or an
        exclusion keeps them from coming.
      </p>
      <p className="mt-3 max-w-3xl text-sm text-ink-3">
        A real group never sees the per-person columns: the result carries only the place, the time and how many cannot
        come.{" "}
        {anonymous
          ? "Place names are the anonymised ones from the repository; set OPTIMIZER_CASES_NAMES to see the real ones."
          : "Place names come from a file on this machine and are not in the repository."}
      </p>

      <nav className="mt-6 flex flex-wrap gap-2" aria-label="Areas">
        {areas.map((a) => (
          <a key={a.id} href={`#${a.id}`} className="btn-ghost btn-sm">
            {a.label}
          </a>
        ))}
      </nav>

      {areas.map((a) => (
        <section key={a.id} id={a.id} className="mt-14 scroll-mt-24">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line-strong pb-2">
            <h2 className="font-serif text-3xl">{a.label}</h2>
            <span className="font-mono text-xs tracking-wider text-ink-3">{a.places} PLACES OPEN THAT DAY</span>
          </div>
          <div className="mt-6 space-y-6">
            {a.cases.map((c) => (
              <CaseCard key={c.name} c={c} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
