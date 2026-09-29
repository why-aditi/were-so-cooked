Versioned runtime prompts (section 8). Every AI call logs the `id@vN` of the prompt it used, so a change in measured quality can be traced to the wording that caused it.

A prompt is never edited in place. Change the text, bump the version, leave the old one until nothing references it.

Not to be confused with `PROMPTS.md` at the repo root, which is the AI-assisted coding history.
