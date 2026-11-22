---
name: wo
description: Ask the owner questions and read his answers in his preferred format. Use whenever you need a decision or a step from the owner, and when he types /wo or "what's open" to list everything you are waiting on him for.
---

# wo: what's open

## Asking the owner

- Put everything you need from the owner in one list at the end of the reply, never scattered through the text and never as a prose paragraph. That covers decisions and his own steps alike (send a reply or a draft, 2FA, a dry run, a payment).
- The open list has a bold heading, **Open**, then one numbered line per item, `<stable number>. **<short title>** (<recommendation, deadline if any, reply hint if a step>)`, with a blank line between items.
- Under each numbered line, add indented sub-bullets. A choice gets one bullet per option: `- **a.** ...`, `- **b.** ...`, `- **c.** ...`. A single step for the owner gets one bullet stating the exact step.
- Each line is in plain words, answerable with a short reply: yes/no, a pick, a value, or "done" for a step.
- An item stays on Open until it is done. A draft the owner needs to send stays on Open until he sends it or holds it. Do not use Todoist to get the owner to do something.
- An item the owner tracks himself, as his own Todoist task (not a Hold task) or in a Codex thread or task he works in directly, stays off the Open list. The owning agent still follows up on it, and may send him a one-line FYI when its state changes.
- A Codex app thread also sets its own pin at the end of every turn, as the fleet's global instructions say: pinned while it needs the owner, unpinned when it does not. A thread with no schedule of its own may pin itself but never unpins itself; it needs an "active check" schedule for that.
- When a Codex app thread you own sends "NEEDS TRI: <title> <id8>: <step>", add that step to your Open list; on "RESOLVED: <title> <id8>", remove it. The owner acts on it in your chat. At `/wo`, also read the threads' pins fresh, add any pinned thread that is not on Open yet, and unpin each unscheduled thread whose need you have checked is gone.
- Each item keeps one stable number in your scope across lists; never renumber it. Nest only the option or step bullets under their item, one level deep.
- Example:

  ```markdown
  **Open**

  1. **Update Claude Code to 2.1.299 on all hosts** (recommend yes)
     - Run the fleet update and verify version readback on all four hosts.

  2. **Plan** (recommend a)
     - **a.** Free
     - **b.** Teams at $6/mo

  3. **Landlord reply** (reply "done")
     - Send the drafted reply above.
  ```

## Held items

- Held items live in Todoist, not in the chat lists. When the owner holds an item, the owning PM files one Todoist task in its own project (the fleet's instructions name it), titled `Hold <n>: <item> (<PM>)`, always with a check date. With no natural date, pick one at most 4 weeks out, and set a new one at each check. Keep the stable number. Never put it in the Inbox.
- When a hold is resolved or comes back to Open, complete its task with a pointer to where it went; never delete it.

## Reading his answers

- Short lines sent together answer the last numbered list in order: the first line answers its first item, and so on.
- "ok", "k", "ye", "lgtm" mean yes. "no" means no. "ok but X" means yes with change X. "hold" moves the item to Held.
- A line ending in "?" is a question about that item. Answer it, then re-ask only that item.
- Fewer lines than items: the rest stay open.
- For a batch of 4 or more answer lines, or a voice answer, start your reply with the mapping: "Read as: 36 yes, 112 hold, 113 ?". Act only on the clear items; ask about a line that could belong to two items, never guess.
- Only "drop" or "stop mentioning" removes an item for good, or the owner taking it into his own Todoist or a Codex thread or task he works in directly.

## /wo

When the owner types `/wo` or asks what's open, reply with only the **Open** list of everything you are still waiting on him for, in your own scope (for "what's open everywhere", follow the fleet's PM routing), oldest first, in the format above, with your recommendation and any deadline in each line's parentheses. Print no Held line or section. If nothing is open, say "Nothing open." Do not repeat status or finished work.
