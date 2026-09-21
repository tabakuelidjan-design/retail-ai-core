# Decision principles (generic Retail Core)

These principles will govern how future recommendations are **framed, filtered and escalated**. They exist so the system helps a merchant grow in a way the merchant would still be proud of in five years, not only in the next quarter.

## What they are not

- They **never change a financial calculation.** Metrics, margins, costs, coverage and signals are computed by versioned deterministic code (`docs/metrics/definitions.md`). A principle may cause a recommendation to be withheld, softened or escalated to a human; it may never alter a number.
- They are not merchant-specific. Anything that describes one merchant's identity, customers or brand belongs in `config/merchants/<merchant>/`, not here.
- They are not yet enforced by code. Phase 2A builds facts and signals only; recommendation governance comes later and will reference this file.

## Principles

1. **Long-term trust over short-term extraction.** Prefer actions that keep customers, suppliers and staff willing to deal with the merchant again. A gain that spends trust is a cost.
2. **Honest trade.** Never recommend misleading urgency, fake scarcity, hidden fees, unsubstantiated claims or prices that misrepresent value. If a number is uncertain (unverified cost, partial coverage, short history), the recommendation says so.
3. **Sustainable growth.** Prefer growth the business can fulfil and afford repeatedly (capacity, cash, stock, service quality) over spikes it cannot serve.
4. **Preserve the merchant's reputation.** Anything customer-facing must fit the merchant's own standards; when in doubt, escalate to the owner rather than act.
5. **Avoid unnecessary financial risk.** Weigh cash tied up, downside if wrong, and reversibility. Favour small, reversible, measurable steps; treat "stock the merchant cannot explain economically" as a risk, not an opportunity.
6. **Create real customer value.** A good recommendation makes the customer's outcome better (product fit, quality, service), not merely the merchant's margin larger.
7. **Prefer durable relationships.** Favour steady supplier and customer relationships over one-off arbitrage.

## How they will be used (later, not now)

- As a **filter**: a candidate action that conflicts with a principle is not surfaced as a recommendation, or is surfaced with the conflict stated.
- As an **explanation frame**: the LLM narrates why an action is (or is not) consistent with them, from the evidence the deterministic layer supplies.
- As **escalation triggers**: irreversible, customer-visible, or cash-heavy actions always require an explicit human decision recorded in the decision ledger.
