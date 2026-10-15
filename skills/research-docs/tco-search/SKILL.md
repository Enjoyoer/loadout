---
name: tco-search
description: Help choose what to buy by comparing total cost of ownership across Amazon and any installed marketplace sources. Use for shopping research, product shortlists, and upfront versus long-term cost comparisons.
---

# TCO Search

Find the best fit over the user's keep period, not just the lowest sticker price. Research only: never buy, add to cart, or sign in.

## Interview first

- Read and follow any installed question-style skill (for example `wo`). Otherwise use one numbered list, one line per question, a recommended default per line, and short-answer choices.
- Use what the user already supplied. Ask only what changes the search: budget (upfront or lifetime), must-haves and deal-breakers, new/used/refurbished, keep period, running-cost importance and relevant usage, and shipping/tax location. Country and postal code or region suffice; never request a full address.
- Ask at most two rounds, then search with explicit assumptions for unanswered details. If everything is already known, go straight to search.

## Search

- Search the relevant Amazon storefront with the browser tools available to the running agent, using ordinary public browsing. No login, CAPTCHA solving, or access-control workarounds. If browser tools are unavailable or Amazon is blocked, say so; do not invent listings.
- Discover and read any installed skills that search other marketplaces, then follow them for additional sources. Do not require a particular marketplace skill or assume it is installed.
- Use one search query per source per refined interview, with no retry or query-variation loops. Opening returned product pages to verify details is fine. A narrower second pass starts only after the user refines the brief.
- Treat a challenge, block, error, or unavailable tool as **no data from that source**, never zero results. Report the limitation and continue with accessible sources. Say zero results only after a successful search actually returns none.
- Compare exact variants and condition against the must-haves. Record public price, currency, shipping, availability, seller, warranty and return terms, links, and observation date. Mark anything unverified or destination-dependent; never assume free shipping or membership benefits.

## Estimate ownership cost

Use the same currency, keep period, and usage assumptions for every candidate:

**TCO = price + shipping + estimated sales tax + expected warranty/return/repair cost + running costs over the keep period - expected resale value at the end.**

- Upfront means price + shipping + estimated sales tax. Avoid double-counting tax already included in the price; disclose any currency conversion and its rate/date.
- Show the assumptions and label estimates. For expected warranty/return/repair costs, explain likelihood × out-of-pocket cost, accounting for coverage and return fees without counting the same loss twice.
- Include relevant power, consumables, and subscriptions over the keep period. State usage and unit rates; distinguish not applicable from unknown. Missing costs are not automatically zero.
- Estimate end-of-period resale conservatively for the expected age and condition, net of selling costs. Cite evidence and explicitly say when the estimate uses asking prices rather than sold prices. Do not present today's used price as guaranteed future resale.
- Use ranges when uncertainty could change the ranking. Without enough evidence for a cost, mark TCO incomplete rather than fabricate precision. Explain close calls and rank only candidates that meet the requirements; if none can be verified, say so.

## Deliver

Give a short ranked table, with assumptions just below it if needed:

| Item | Source | Upfront | TCO | Key assumptions | Link |
| --- | --- | --- | --- | --- | --- |

State the keep period and currency, disclose source limitations, then give a one-line pick with why it wins for this user. If evidence is insufficient, make the pick conditional or say no defensible pick yet. Offer a narrower second pass, without starting another search automatically.
