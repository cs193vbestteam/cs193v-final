/**
 * The messages a member can drop into the group chat. Both are built only from what every
 * member of the plan already sees on the page: the title, the chosen place and time, and
 * how many people are done. Never a constraint, a verdict or a name.
 */

export function resultMessage(o: { title: string; place: string; when: string; options: number; url: string }): string {
  const more = o.options > 1 ? `See all ${o.options} options` : "See the plan";
  return `${o.title} is settled: ${o.when} · ${o.place}. ${more}: ${o.url}`;
}

export function nudgeMessage(o: { title: string; ready: number; members: number; url: string }): string {
  return `${o.title}: ${o.ready} of ${o.members} of us are done. Tell your assistant what works for you, it takes a minute: ${o.url}`;
}
