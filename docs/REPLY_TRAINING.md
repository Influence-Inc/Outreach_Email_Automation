# Teaching Claude how Jennifer replies

The negotiation model can't be fine-tuned, so "training" here means feeding it
labeled (creator inbound → manager reply) pairs from past threads as few-shot
examples in the prompt. Same idea as showing a new hire a stack of "here's how
we replied to this kind of message" examples on day one.

Since the continuous-learning update this happens **by itself**: the system
reads Jennifer's mailbox on a schedule, and captures every human reply sent
from the Delegate window the moment it goes out. The goal of the delegate feed
is direct: every doubt/question a human answers once should stop reaching the
Delegate queue, because the model now has that exact Q→A pair to imitate.

## How it's wired

`backend/src/services/replyExamples.js` merges three example sources:

| Source | Where it lives | Fed by |
|---|---|---|
| `backend/data/seed_examples.json` | committed file | hand-written, covers every action label |
| `backend/data/harvested_examples.json` | git-ignored legacy file | the old Gmail harvest; still read if present |
| **`reply_examples` table** | Postgres (survives redeploys) | the two continuous feeds below |

For every creator reply, `handleCreatorReply()` picks the top 4 most relevant
examples (Jaccard token overlap on the inbound text, lightly boosted when the
stage matches, and again when the example is a human `delegate` answer) and
prepends them as `user`/`assistant` message turns before the real inbound. The
system prompt tells Claude the facts in those past exchanges are team-approved
knowledge — so a question a human answered once becomes answerable by the
model, instead of escalating again.

The example pick is capped at 2 per action label so the model sees a diverse
set instead of 4 copies of the same label biasing it.

## Quoted history: the new message vs. the thread under it

Every real reply arrives with the mail client's copy of our previous email
pasted below it. `backend/src/services/emailQuote.js` (`splitQuotedReply`)
finds that boundary — Gmail's `On … wrote:` line including its wrapped form,
Outlook's `-----Original Message-----` / underscore-and-headers divider,
forwarded-message markers, `>` quoting, `<blockquote>` / `div.gmail_quote` in
HTML bodies, and mobile-client footers — and everything that reasons about
"what the creator said" reads the new half only:

- **who to greet** — `services/salutation.js`. Reading the tail of the raw body
  meant reading OUR sign-off, which is how a reply from the creator went out
  addressed "Hi Jennifer," and referred to the creator in the third person.
  The resolved name is passed to Claude as a hard rule; the prompt no longer
  asks the model to find a name for itself.
- **example matching + the deterministic fallbacks** — harvested examples are
  stored de-quoted, so matching a raw body against them compares different
  things, and the rate/intent heuristics would otherwise mine our own quoted
  offer for the creator's numbers.
- **learned examples and timeline gists** — `replyLearning.stripQuotedHistory`
  is a thin wrapper over the same splitter, so the live path and the learning
  path can't drift apart.

Claude still *sees* the quoted thread on the classify call — the terms already
discussed are real context — but it arrives under an explicit label saying the
messages are already-sent, mostly ours.

## Who wrote the reply — the creator, or someone acting for them?

This decides two things: the name in "Hi X," and whether the email talks about
the creator in the third person ("Kam's happy with the structure") or addresses
its reader directly. Getting it wrong in the third-person direction is the more
embarrassing failure, so the whole path is biased against it.

The sending address barely helps — managers routinely reply from the creator's
own inbox, and creators sometimes write from a second address — so it is only a
tiebreaker. `negotiation.judgeSender()` asks Claude to read the message and
answer `{sender_name, wrote_by, confidence, why}`, once per inbound, and the
answer is cached on `creators.reply_salutation` / `reply_is_delegate` so the
later offer / contract / follow-up sends reuse it without another call.

The answer is treated as a suggestion, not as trusted output:

- the proposed name goes through `salutation.vetGreeting()` — the same
  guarantees as every other source, so it can never be our own manager name, a
  role word, or a whole sentence;
- **"someone else wrote this"** needs high confidence (or the patterns agreeing)
  before it flips the email into the third person; **"the creator wrote this"**
  always stands, because it reads correctly either way;
- when the writer isn't the creator and named nobody, the greeting is
  "Hi there," — addressing a manager by the creator's name is the mistake being
  avoided;
- no API key, a bad JSON body, or a failed call leaves the deterministic answer
  in place.

`salutation.judgeSenderHeuristically()` is that fallback: explicit relationship
statements ("I'm Kam's manager", "my client"), third-person talk about the
creator ("he'd want 50% upfront", "Kam asked me to reply"), first-person
ownership of the account or the work ("my page", "I'd be producing the
content"), and only then the sending address.

## Feed 1 — Delegate replies (live, per-reply)

When Claude escalates a reply it can't handle, the creator lands in the
Delegate queue and a human answers from the Delegate window. The moment that
reply is sent, `replyLearning.learnFromHumanReply()`:

1. Labels the (creator question → human answer) pair with Claude, using the
   same 9-action taxonomy the live prompt uses.
2. Drops it if the reply contains a priced offer (offers only ever come from
   the admin-approval flow) or isn't a real creator↔manager exchange.
3. Stores it in `reply_examples` with `source = 'delegate'` and logs a
   `learned_example` event on the creator's timeline.

Next time any creator asks a similar question, the human's answer is retrieved
as a few-shot example and Claude answers directly. Disable with
`LEARN_FROM_DELEGATE=0`.

## Feed 2 — Mailbox harvest (scheduled, whole inbox)

Every `LEARN_HARVEST_HOURS` (default 24, `0` disables) the scheduler sweeps
the connected mailbox (`jennifer@useinfluence.xyz`) **through the Instantly
API** — the old Gmail/OAuth path was removed when sending moved to Instantly.
The sweep:

1. Lists mailbox emails (`GET /api/v2/emails`), newest first, up to
   `LEARN_HARVEST_MAX_EMAILS` (default 500) per run.
2. Rebuilds each thread and pairs every creator message with the next reply
   from our side (`SENDER_EMAIL` / `INSTANTLY_EACCOUNT` / the email's
   `eaccount` decide which messages are "ours").
3. Skips pairs already in `reply_examples` **before** any Claude call, so
   repeat sweeps cost nothing for old mail.
4. Labels each new pair, drops priced offers, stores the keepers with
   `source = 'harvest'`.

Because the harvest reads the mailbox itself, it also learns from replies a
human sent outside this app. The last-run timestamp lives in `app_settings`
(`learn_last_harvest_at`), so the cadence survives restarts.

### Manual backfill / ad-hoc runs

```bash
cd backend

# Default sweep (same as the scheduled one)
npm run learn:harvest

# First big backfill
node scripts/harvest-inbox.js --limit 2000

# Only pairs replied to in the last 90 days
node scripts/harvest-inbox.js --days 90

# Label + print per-action counts, store nothing
node scripts/harvest-inbox.js --dry-run
```

Requires `INSTANTLY_API_KEY`, `ANTHROPIC_API_KEY`, and `DATABASE_URL`.

New examples are picked up immediately in-process; other processes see them on
their next periodic refresh (~10 min) or restart.

## Running it as a test suite

```bash
# Offline: replays every example through handleCreatorReply with a stubbed
# Claude that returns the labeled JSON. Also covers the learning pipeline
# (pairing, labeling, skip rules, delegate capture). ~1s.
npm test

# Live: actually calls Claude on each example, holds the example out of its
# own few-shot pool, reports per-action accuracy, and fails if overall
# accuracy drops below 70%. Costs a few cents per run.
ANTHROPIC_API_KEY=sk-... npm run learn:eval
```

`learn:eval` is the one to run after a prompt or template change — it answers
"did this change help or hurt on the historical reply distribution?"

## Inspecting and pruning the learned bank

Everything learned lives in the `reply_examples` table:

```sql
-- What has been learned, newest first
SELECT id, source, expected_action, LEFT(inbound, 60) AS inbound, created_at
FROM reply_examples ORDER BY created_at DESC LIMIT 50;

-- Retire a bad example without deleting it (kept for audit)
UPDATE reply_examples SET enabled = FALSE WHERE id = 'harvest_...';
```

Disabled rows stop being served on the next refresh. Delegate learns also
append a `learned_example` row to `email_events`, so the creator's timeline
shows what the system picked up from that conversation.

## Adding new examples by hand

Either insert a row into `reply_examples` (`source = 'manual'`), or edit
`backend/data/seed_examples.json`. Each seed entry needs:

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
  pattern; the system prompt enforces the rules. Learned examples never carry
  priced offers, and the prompt forbids copying dollar amounts or another
  creator's specifics out of an example.
- It won't fix systematic misclassification on a label that has zero examples
  in the bank — add a couple of seed examples for that label first.
