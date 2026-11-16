{\rtf1\ansi\ansicpg1252\cocoartf2867
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\fswiss\fcharset0 Helvetica;\f1\fswiss\fcharset0 Helvetica-Bold;}
{\colortbl;\red255\green255\blue255;}
{\*\expandedcolortbl;;}
\margl1440\margr1440\vieww11520\viewh8400\viewkind0
\pard\tx720\tx1440\tx2160\tx2880\tx3600\tx4320\tx5040\tx5760\tx6480\tx7200\tx7920\tx8640\pardirnatural\partightenfactor0

\f0\fs24 \cf0 Three APIs we paying for:\
1. Claude - we use claude\'92s api key to make llm calls\
2. google places: a geocode and nearby search\
3. neon: for storage and compute\
\

\f1\b Limits:
\f0\b0 \
Claude: (see buttom for definition of different calls)\
1. for claude, there are caps on chat: per 10mins, 30 messages per person. messages capped at 500 character, replies capped at 400 characters, 512 output tokens every chat call.\
2. 300 calls per plan per day. (each person\'92s call is counted under the plan call, which also include chat calls, agent call, mediator call, explainer calls), output cap of 200 tokens(mediator), 150(explainer) and up to 4000(agents, slaced to the number of options. \
3. each person per month is given 10 dollars total for the whole app. reset every calendar month.\
4. each person\'92s own chat is charged to themselves. negotiation will goes to the plan\'92s initiator. app falls back to rule-based code when cap is hit.\
\
Google places:\
1. each plan makes 1 geocode and 1 general nearby search call when it is created. Then once everyone finishes submitting their requirements. 7 more search max per plan (each time 20 places max, so total 160 places)\
\
Accounts and logins(Neon):\
1. 10 new accounts per IP per hour, 10 login attempts for each email, 50 for eahc IP for 15 minutes\
\
Plan limit:\
1. each person can only create 10 plans a day.\
\
Def for calls of llm:\
- chat: people send their private message and contraint to llm\
- agent call: each person\'92s agent judges that round\'92s options using only that persons\'92 own preferences\
- mediator call: one per round. picks which options to propose.\
- explainer call: one per finished plan, describe the chosen plan\
\
}