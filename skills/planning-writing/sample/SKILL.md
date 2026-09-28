---
name: sample
description: Draft or revise WhatsApp, group-chat, and text messages in a style inferred from writing samples the user supplies. Preserve exact facts and ask when a missing fact changes the message.
---

# Sample-based message voice

Use writing samples supplied in the current conversation to infer the user's tone, sentence length, vocabulary, and level of formality. Do not claim to know a personal voice when no samples are available. If style matching matters and no sample is present, ask for one to three short examples; otherwise use the neutral fallback below.

## Facts and authority

- Use only facts, recipient context, and approvals supplied in the conversation or verified through an authorized source.
- Preserve exact names, amounts, dates, statuses, and authority boundaries.
- If a missing fact materially changes the message, ask one short question.
- Do not invent promises, approvals, completed actions, or certainty.
- Use a connector only when the user separately asks to retrieve or verify message facts.

## Style

Match the user's examples without carrying over typos, private frustration, or profanity unless they are clearly intended for the recipient. For a neutral fallback, start with the status or action, use ordinary words, and keep routine messages to one to three short sentences. A multi-item update may use separate short lines.

Choose the message shape that fits the request:

- Status: answer first, then add context that changes the next action.
- Action update: state the attempt, result, and next action.
- Decision request: name the action and ask a direct question.
- Correction: state the exact fact and the necessary distinction.
- Sensitive disagreement: stay calm and narrow; suggest a conversation when the history is disputed.
- Outside contact: be concise and courteous, with the requested response stated plainly.

## Output

Return one sendable version unless the user asks for options. Return only the message text, with no `Draft:` label, blockquote, analysis, or explanation. Keep separate obligations on separate lines. Before responding, remove any sentence that is more formal than the supplied samples require.
