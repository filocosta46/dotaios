# Foundation Reliability Wayfinder

This directory is the local Markdown issue tracker for the Foundation reliability programme.

- [`Foundation reliability specification and release-candidate slice`](map.md) is the canonical Wayfinder map.
- Each file under [`issues/`](issues/) is one decision or investigation ticket.
- `status: open` and an empty `assignee` mean the ticket is on the unclaimed frontier when every item in `blocked_by` is closed.
- A resolution is recorded in the ticket before `status` becomes `closed`; the map then receives only a one-line linked gist.

The map charts decisions. Implementation work begins only after the product contract, first slice, acceptance scenarios, and blocking edges are settled.
