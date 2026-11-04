# Tacit: group plans without the group chat

## The problem
A group of friends wants to decide one thing together, say five friends picking a restaurant for the weekend. Today the process is someone dropping "what do we eat Saturday?" into the group chat, followed by twenty messages: A says "whatever", B says "nothing too pricey", C has something on Saturday afternoon, D hasn't opened the chat, E posts a link nobody reads. Three days later it either dies or the one person who loves organising decides and the others go along.

## Why it happens
Everyone has real constraints and preferences (a budget ceiling, no spicy food, only free Saturday night, won't drive more than 20 minutes), but nobody wants to say them in the group. "My budget is $40" sounds stingy; "I don't want to go far" sounds difficult. So everyone says "whatever", the information stays hidden, and the group is guessing.

## What the product does
1. Each person has a one-minute private chat with their own AI assistant and tells it their real constraints and preferences. Only that person and their assistant see this. The rest of the system cannot read it.
2. The system proposes a few candidate plans (Saturday 7pm, a Japanese place, about $45 a head) and asks every person's assistant "does this work?". An assistant only answers accept / reluctant / reject, plus at most one reason category such as "price". It never reveals numbers.
3. The system adjusts the proposals from those answers and asks again. After two or three rounds it finds a plan everyone accepts. From round four, each assistant quietly loosens one thing its owner said they'd give up first; nobody else learns what.
4. The group chat only ever receives the final result: "Saturday 7pm, Olive Tree Mezze, about $27 a head, everyone's in."

## What people get
- Nobody has to expose their budget, schedule or dietary needs in the group, yet all of it is taken into account.
- Three days of back-and-forth become one minute of private chat and a few seconds of waiting.
- The outcome is not the loudest person's plan; it is the plan that works for everyone, with no one visibly sacrificed.

## How it differs from existing tools
When2meet only solves time. Splitwise only solves money. Group polls need someone to propose options first. Tacit starts from each person's real constraints, generates the options automatically, and protects everyone's privacy. Private chats and constraints are encrypted at rest; the negotiation engine never receives anyone's preferences, only verdicts.

## Scope of the first version
Meals and outings only. Trips, shared apartments and splitting chores come later.

## The people in this story
Five computer-science students at Stanford have been trying to get dinner together for two weeks. One always says "whatever works". One is quietly broke this month. One lives off campus and hates driving. One is vegetarian but never brings it up. One is the organiser who usually ends up deciding for everyone and is tired of it. They have just been told about Tacit and are deciding whether to try it for this weekend's dinner.
