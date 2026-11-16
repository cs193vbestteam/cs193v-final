Three APIs we paying for:
1. Claude - we use claude’s api key to make llm calls
2. google places: a geocode and nearby search
3. neon: for storage and compute

Limits:
Whole app:
1. 10 dollars for the whole app per month to avoid over cost.

Claude: (see buttom for definition of different calls)
1. for claude, there are caps on chat: per 10mins, 30 messages per person. messages capped at 500 character, replies capped at 400 characters, 512 output tokens every chat call.
2. 300 calls per plan per day. (each person’s call is counted under the plan call, which also include chat calls, agent call, mediator call, explainer calls), output cap of 200 tokens(mediator), 150(explainer) and up to 4000(agents, slaced to the number of options. 
3. each person per month is given 10 dollars for claude api. reset every calendar month.
4. each person’s own chat is charged to themselves. negotiation will goes to the plan’s initiator. app falls back to rule-based code when cap is hit.

Google places:
1. each plan makes 1 geocode and 1 general nearby search call when it is created. Then once everyone finishes submitting their requirements. 7 more search max per plan (each time 20 places max, so total 160 places)

Accounts and logins(Neon):
1. 10 new accounts per IP per hour, 10 login attempts for each email, 50 for eahc IP for 15 minutes

Plan limit:
1. each person can only create 10 plans a day.

Def for calls of llm:
- chat: people send their private message and contraint to llm
- agent call: each person’s agent judges that round’s options using only that persons’ own preferences
- mediator call: one per round. picks which options to propose.
- explainer call: one per finished plan, describe the chosen plan

