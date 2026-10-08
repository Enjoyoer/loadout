# Large Web Pro inputs

Read this when a Web Pro prompt would carry more than about 90 KB, or a review spans more files than one prompt holds, such as a whole-suite simplifier pass. The PR reviewer helper stays metadata-only.

## Limits

An agent creation prompt has a hard limit of about 100 KB, the Paseo daemon's default request body limit. One ChatGPT message holds about 104K tokens. Oversized prompts fail with `PayloadTooLargeError` or input errors, so size the prompt before launch.

## Prefer the GitHub connector

When the code is in a GitHub repository the owner's ChatGPT account can reach, public or private, let Web Pro read the files itself. Give a short prompt with the repository, a pinned full commit SHA, the shard's file list or directory, and the remit.

First run one cheap probe: ask Web Pro to list three file names at the pinned commit, quote one name (such as a function or test) from each, and say plainly if it cannot read the repository. Verify the quotes locally at that commit before launching shards. A failed or unverifiable probe means pasted shards.

## Shard

Shard large reviews by directory, keeping related files together. Use one fresh one-shot agent per shard under the web lane rules. Shards are rounds of the run's single web lane: run them sequentially, or at most two tabs at once.

## Without connector access

Paste sanitized sources in shards under about 90 KB each, leaving room for the remit. Pasted raw content is the case the [risk record](web-models-not-approved.md "branch:risk") ties to observed safety blocks.

## Evidence

A deep pass over a few hundred test files through 24 connector shards took about 4.5 hours in one tab, against an estimated 10 to 14 hours for 139 pasted packs, and found removals an earlier shallow pasted pass missed.
