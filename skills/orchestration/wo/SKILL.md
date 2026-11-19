---
name: wo
description: Ask the owner questions and read his answers in his preferred format. Use whenever you need decisions from the owner, and when he types /wo or "what's open" to list everything you are waiting on him for.
---

# wo: what's open

## Asking the owner

- Put every decision the owner must make in one list at the end of the reply, never scattered through the text and never as a prose paragraph.
- The open list uses the same format as the Held list: a bold heading, **Open**, then one numbered line per item, `<stable number>. <short item> (<recommendation>)`. Options or sub-items go as a, b and c on that same line.
- Each line is in plain words, answerable with a short reply: yes/no, a pick, or a value.
- The list holds only decisions. The owner's own dated actions (pay, call, sign, post) stay in Todoist; show them at most as one line, "Due today in Todoist: N".
- An item the owner tracks himself, as a Todoist task or in a Codex thread or task he works in directly, appears in neither the open list nor Held. The owning agent still follows up on it, and may send him a one-line FYI when its state changes.
- Each item keeps one stable number in your scope across lists; never renumber it. Never nest a list inside the list.
- Example:

  ```
  **Open**
  1. Update Claude Code to 2.1.299 on all hosts (recommend yes)
  2. Trim old Codex backups on the PC, frees 7.5 GB (recommend yes)
  3. Plan: a Free, b Teams at $6/mo (recommend a)

  **Held**
  4. Move the NAS backups to new disks (check 11/25)
  ```

## Reading his answers

- Short lines sent together answer the last numbered list in order: the first line answers its first item, and so on.
- "ok", "k", "ye", "lgtm" mean yes. "no" means no. "ok but X" means yes with change X.
- A line ending in "?" is a question about that item. Answer it, then re-ask only that item.
- Fewer lines than items: the rest stay open.
- For a batch of 4 or more answer lines, or a voice answer, start your reply with the mapping: "Read as: 36 yes, 112 hold, 113 ?". Act only on the clear items; ask about a line that could belong to two items, never guess.
- A held item never leaves the list. Only "drop" or "stop mentioning" removes an item, or the owner taking it into Todoist or a Codex thread or task he works in directly.

## /wo

When the owner types `/wo` or asks what's open, reply with only the **Open** list of decisions you are still waiting on him for, in your own scope, oldest first, in the format above, with your recommendation and any deadline in each line's parentheses. Then append every held item at the bottom under a bold **Held** heading in the same format: same stable number, one line, with its check date in the parentheses when it has one. If nothing is open or held, say "Nothing open." Do not repeat status or finished work.
