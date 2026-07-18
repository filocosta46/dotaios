---
status: draft
external_accounts_created: false
send_enabled: false
---

# Email list plan

The list has one job: tell interested people when DotAIOS or the Independent Consultant Pack has a useful release. It is not required to download the free core, visit the documentation or buy the pack.

No provider account should be created until Filippo approves the provider, data terms, cost and final form copy.

## Consent and data rules

- Use a separate, unchecked consent box. Entering an email at checkout is not marketing consent.
- Use double opt-in. Do not add an address until the owner confirms it.
- Put an unsubscribe link in every marketing email and process it immediately.
- Keep the free download available without an account or mailing-list signup.
- Do not import contacts from personal inboxes, previous clients or Gumroad without specific consent for DotAIOS marketing.
- Do not send document contents, product usage or AI prompts to the email provider.

Minimum records:

- Email address.
- Preferred language, only if the person chooses it.
- Consent text version, source page and timestamp.
- Confirmation timestamp and unsubscribe status.

Do not collect names, job titles, company names, phone numbers or behavioral profiles for the first launch. If a field has no defined use, remove it.

## Retention proposal

- Delete unconfirmed signups after 30 days.
- Keep the minimum suppression record needed to respect an unsubscribe. Do not reuse it for marketing.
- After 24 months with no opens, clicks or replies, ask once whether the person wants to stay. Delete inactive marketing records if there is no confirmation.
- Provide a simple privacy contact for access and deletion requests.

The exact retention periods require a final privacy review before collection starts.

## Provider gate

Compare providers on:

- Data processing agreement and GDPR support.
- EU data options and subprocessors.
- Double opt-in, one-click unsubscribe and export or deletion controls.
- A usable free tier with no surprise sending cost.
- Plain email support without forced tracking pixels.
- API and admin security, including two-factor authentication.

Tracking should be off by default. If link or open tracking is later considered, explain it in the privacy notice and approve it separately.

## Form copy

### English

Field label: Email

Button: Get occasional DotAIOS updates

Consent: I want product and launch emails from DotAIOS. I can unsubscribe at any time. Signing up is optional and is not required to use the free product.

Confirmation: Check your inbox and confirm your address. You will not join the list until you do.

Success: You are on the list. Expect emails only when there is something useful to share.

### Italiano

Etichetta: Email

Pulsante: Ricevi aggiornamenti occasionali su DotAIOS

Consenso: Voglio ricevere email su prodotto e lancio da DotAIOS. Posso annullare l'iscrizione in qualsiasi momento. L'iscrizione è facoltativa e non serve per usare il prodotto gratuito.

Conferma: Controlla la posta e conferma il tuo indirizzo. Entrerai nella lista solo dopo la conferma.

Messaggio finale: Iscrizione completata. Riceverai un'email solo quando avremo qualcosa di utile da condividere.

## First four emails

1. Confirmation and welcome: what DotAIOS is, where the free core lives and how to unsubscribe.
2. Monday release: one use case, current compatibility and honest limitations.
3. Practical setup note: one small workflow a non-developer can use.
4. Consultant Pack availability: send only after the checkout gate passes. Make the paid pack optional and keep the free route visible.

Every send is a draft first. Filippo approves the audience, subject and exact body before it leaves the system.

## Launch checks

- Privacy notice names the provider, purpose, retention and contact.
- Consent, confirmation, unsubscribe, export and deletion all work in a test list.
- No existing contact appears in the test list.
- The website works when the form is blocked or unavailable.
- No autonomous send, posting loop or cron exists.
