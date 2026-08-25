---
name: skillify
description: Turn a repeated workflow or prompt into a reusable DotAIOS skill, drafted for you, saved only after you approve.
triggers: skillify this, make this a skill, turn this into a skill, save this as a skill, I keep doing this, automate this workflow, remember how to do this
when_to_use: skillify this · make this a skill · turn this into a skill · save this as a skill · I keep doing this · automate this workflow · remember how to do this
---

# Skillify

Turn something the user does repeatedly into a reusable skill, so any agent on this
machine can run it later. You draft it, the user approves, then it is saved and
becomes routable through `skills/RESOLVER.md`.

## When to use this
- The user says "skillify this", "make this a skill", or similar.
- You notice the user has asked for the same kind of workflow 2+ times, or keeps
  pasting the same prompt. Offer: "You've done this a few times, want me to make
  it a reusable skill?"

## Hard rules (do not break)
- **Ask before saving.** Draft the skill and show it to the user. Only write files
  after they say yes. Never auto-save a generated skill.
- **No eval rig.** A skill is markdown plus, at most, one tiny script. Do not add
  scoring, LLM evals, or routing-eval files. The user's approval is the quality gate.
- **No secrets.** Never put credentials, tokens, or private data into a skill.

## Steps
1. **Check it's worth it.** Skillify only if the workflow is reusable (done 2+
   times) and has a clear thing the user would say to trigger it. One-off tasks
   stay one-off.
2. **Pick a slug**, short, lowercase-hyphenated, e.g. `weekly-report`.
3. **Draft the skill.** Write the body as clear, ordered steps an agent can follow.
   Choose 3 to 6 natural trigger phrases the user would actually say.
4. **Show the draft** (frontmatter + steps) and ask: "Save this as a skill?"
5. **On approval**, create `skills/<slug>/SKILL.md` with this frontmatter, then the steps:
   ```
   ---
   name: <slug>
   description: <one line of what it does>
   triggers: <phrase>, <phrase>, <phrase>
   ---
   ```
6. **Reindex** so every agent can find it: run `npx dotaios@<exact-candidate-version> activate`. This
   regenerates `skills/INDEX.md` and `skills/RESOLVER.md`. Confirm the new skill
   appears in RESOLVER.md.
7. **Tell the user** it is saved and which phrases now trigger it.

## Output
A new `skills/<slug>/SKILL.md`, registered in INDEX.md + RESOLVER.md, runnable by
any agent on this machine.
