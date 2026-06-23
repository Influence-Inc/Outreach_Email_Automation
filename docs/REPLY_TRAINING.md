# Teaching Claude how Jennifer replies

The negotiation model can't be fine-tuned, so "training" here means feeding it
labeled (creator inbound → manager reply) pairs from past threads as few-shot
examples in the prompt. Same idea as showing a new hire a stack of "here's how
we replied to this kind of message" examples on day one.

## How it's wired

`backend/src/services/replyExamples.js` loads two JSON banks at startup:

| File | Committed? | Source |
|---|---|---|
| `backend/data/seed_examples.json` | yes | hand-written, covers every action label |
| `backend/data/harvested_examples.json` | **no** (gitignored — contains creator PII) | produced by the harvest script below |

For every creator reply, `handleCreatorReply()` picks the top 4 most relevant
examples (Jaccard token overlap on the inbound text, lightly boosted when the
stage matches) and prepends them as `user`/`assistant` message turns before the
real inbound. The system prompt is unchanged.

The example pick is capped at 2 per action label so the model sees a diverse
set instead of 4 copies of the same label biasing it.

## Harvesting real threads from `jennifer@useinfluence.xyz`

Requires the same env the backend uses (Google OAuth tokens stored in the DB,
`SENDER_EMAIL` set, and `ANTHROPIC_API_KEY` for the labeler):

```bash
cd backend

# Default: scans all threads, caps at 200, writes harvested_examples.json
npm run learn:harvest

# Last 90 days only
node scripts/harvest-inbox.js --query 'newer_than:90d'

# Bigger sweep
node scripts/harvest-inbox.js --limit 1000

# Dry run — just print per-action counts, don't write
node scripts/harvest-inbox.js --dry-run
```

The script:

1. Lists threads in Jennifer's mailbox via the existing OAuth client.
2. For each thread, finds every (inbound creator message → next outbound
   Jennifer reply) pair.
3. Sends each pair to Claude with a labeling prompt that classifies it into
   one of the 9 action labels and extracts `quoted_rate` if any.
4. Drops pairs where Jennifer's reply contains a priced offer — those come from
   the admin approval flow, not the model.
5. Writes the kept pairs to `data/harvested_examples.json`.

After the harvest, the negotiation prompt automatically starts using the new
examples — no code change, no restart needed beyond the natural process restart
(`replyExamples.js` caches on first load).

## Running it as a test suite

```bash
# Offline: replays every example through handleCreatorReply with a stubbed
# Claude that returns the labeled JSON. Verifies the wiring, the action
# routing, the quoted_rate parsing. ~50ms.
npm test

# Live: actually calls Claude on each example, holds the example out of its
# own few-shot pool, reports per-action accuracy, and fails if overall
# accuracy drops below 70%. Costs a few cents per run.
ANTHROPIC_API_KEY=sk-... npm run learn:eval
```

`learn:eval` is the one to run after a prompt or template change — it answers
"did this change help or hurt on the historical reply distribution?"

## Adding new examples by hand

Edit `backend/data/seed_examples.json`. Each entry needs:

```json
{
  "id": "seed_<action>_<short_slug>",
  "expected_action": "asking_details",
  "expected_quoted_rate": null,
  "stage": "AWAITING_RATE",
  "inbound": "what the creator wrote",
  "outbound_subject": "Re: …",
  "outbound_body": "what Jennifer would reply (or null if no email)",
  "notes": "what action this demonstrates"
}
```

For canonical templates, use `"outbound_body_template": "REPLY1"` or `"REPLY2"`
instead of `outbound_body` — the loader expands it.

The 9 action labels live in `negotiation.js` and `replyExamples.js`
(`ACTIONS`); add an example for any label that's under-represented after
running the harvest.

## What this *doesn't* do

- It's not real fine-tuning. The model weights don't change.
- It doesn't override the system prompt's hard rules (no offer numbers, no
  invented terms, escalate on usage rights / legal). Few-shot demonstrates the
  pattern; the system prompt enforces the rules.
- It won't fix systematic misclassification on a label that has zero examples
  in the bank — add a couple of seed examples for that label first.
