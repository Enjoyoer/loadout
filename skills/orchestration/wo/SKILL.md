---
name: wo
description: Ask the owner questions and read his answers in his preferred format. Use whenever you need decisions from the owner, and when he types /wo or "what's open" to list everything you are waiting on him for.
---

# wo: what's open

## Asking the owner

- Put every decision the owner must make in one numbered list at the end of the reply, never scattered through the text.
- One line per item, in plain words, answerable with a short reply: yes/no, a pick, or a value. State your recommendation in the line.
- The list holds only decisions. The owner's own dated actions (pay, call, sign, post) stay in Todoist; show them at most as one line, "Due today in Todoist: N".
- Each item keeps one stable number in your scope across lists; never renumber it. Never nest a numbered list inside the list; use a, b and c for options or sub-items.
- Example:
  1. Update Claude Code to 2.1.299 on all hosts? I recommend yes.
  2. Trim old Codex backups on the PC (frees 7.5 GB)? I recommend yes.
  3. Plan: Free or Teams ($6/mo)? I recommend Free.

## Reading his answers

- Short lines sent together answer the last numbered list in order: the first line answers its first item, and so on.
- "ok", "k", "ye", "lgtm" mean yes. "no" means no. "ok but X" means yes with change X.
- A line ending in "?" is a question about that item. Answer it, then re-ask only that item.
- Fewer lines than items: the rest stay open.
- For a batch of 4 or more answer lines, or a voice answer, start your reply with the mapping: "Read as: 36 yes, 112 hold, 113 ?". Act only on the clear items; ask about a line that could belong to two items, never guess.
- A held item leaves the list until its check date. "drop" or "stop mentioning" removes it for good.

## /wo

When the owner types `/wo` or asks what's open, reply with only the numbered list of decisions you are still waiting on him for, in your own scope, oldest first, with your recommendation each. Include deadlines. If nothing is open, say "Nothing open." Do not repeat status or finished work.
