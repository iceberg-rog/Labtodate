# Changes manifest — 2026-05-29 (round 4)

Continuous-recovery batch, driven by real both-sides browser testing
(admin + buyer on the owner account). Production unchanged until you deploy.
All changes pass `npx tsc --noEmit` (exit 0, full project). Large-file edits
done via the shell, not the Edit tool.

## Code changes

### BUG-018 (P1) — customer reply on an archived ticket/quote was a lost message
**Browser-confirmed on prod:** admin archived ticket `TKT-2026-7VVTQU`, buyer
replied from `/app/support`, a "Customer replied" toast fired BUT the ticket did
NOT return to the admin Open queue (Open = 0; it stayed in Archived). An admin
working the queue would never see the waiting customer.

- **src/lib/support/actions.ts** — `customerReplyTicket` now also sets
  `archivedAt: null, archivedById: null` so a customer reply resurfaces the
  ticket to the working queue (alongside `status: WAITING_ON_SUPPORT`).
- **src/lib/quotes/actions.ts** — `replyToQuote` now clears
  `archivedAt/archivedById` when the reply is from the buyer (`!fromStaff`), so a
  buyer reply resurfaces an archived quote.

## Browser-VERIFIED this batch (current-deployed build, TEST data)
- Buyer area renders: `/app` Overview, Orders, Quotes, Inbox, Support — all 200.
- Cross-side state is consistent (buyer overview reflected the open ticket/quote).
- **BUG-018 reproduced live** (the core finding above).
- `setTicketStatus` works (test ticket set to CLOSED).

## Test-data cleanup (proof)
- Ticket `TKT-2026-7VVTQU`: set **CLOSED** + **Archived** ("Status set to closed").
- Quote `RFQ-5AF2X4`: **Archived** (out of admin queue). Full CLOSE requires
  claim-first in the current UI (see UX note below) — left archived as the QA artifact.
- No hard deletes. All records carried the `QA-E2E` prefix.

## Also logged (not code-changed yet)
- **BUG-019 (P2)** — admin "Archive" gives no buyer-facing closure; buyer keeps
  seeing "Awaiting your reply" / "WAITING FOR SUPPLIER". Partially mitigated by
  BUG-018 (a buyer reply now pulls it back). Recommend prompting for a terminal
  status on archive.
- **Minor UX** — admin quote detail exposes only Claim/Transfer; no direct
  "Close/Lost" action (must claim first). Worth a quick affordance.

## Still blocked (logged, not stopping)
- **Deploy** — no deploy-host access (SSH forbidden as leaked). Round-2/3/4 fixes
  stay UNVERIFIED until you deploy.
- **Cross-buyer isolation (B7)** — needs `norouzi` (or any 2nd buyer) logged into
  the Chrome window the Claude extension controls (currently the admin window).
- **Full TEST order E2E (B2–B6, B11–B13)** — next batch on the owner account.

## Files this batch
```
src/lib/support/actions.ts   (BUG-018)
src/lib/quotes/actions.ts    (BUG-018)
BUGS.md, CHANGES-2026-05-29-round4.md
```
