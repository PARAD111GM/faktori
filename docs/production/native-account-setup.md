# Native distribution account setup

Checked against provider documentation on October 13, 2026. Account creation
and identity verification are owner steps; local simulator/emulator qualification
continues independently. No enrollment payment or agreement acceptance has been
authorized by asking for setup help.

## Choose the publisher

Use an existing legal company if its name should appear as the publisher and
the owner can bind it to the providers' agreements. Prepare its exact legal
name, address, website, contact details and D-U-N-S number. Otherwise select a
personal account and review the public identity implications before enrolling.
Do not invent a company or reuse an unrelated company's identity.

The owner selected an existing company and needs help obtaining its D-U-N-S
number. Begin with [Apple's lookup/request route](https://developer.apple.com/help/account/membership/D-U-N-S/):
the company may already have a number, and the request through this route is
free. Use the exact registered entity, not a DBA or trade name. Apple advises
allowing up to five business days for D&B issuance and up to two further business
days for Apple to receive the information. Paid expediting does not shorten
Apple's stated waiting period. Obtain the owner's legal name/address/country
and website before preparing the request; do not infer them from unrelated
projects or private memory.

## Apple

Start at [Apple Developer enrollment](https://developer.apple.com/help/account/membership/program-enrollment/).
Sign in with the owner's Apple Account, enable two-factor authentication and
select individual or organization enrollment. Organization enrollment requires
the legal entity's D-U-N-S number and authority to enter legal agreements.
The Apple Developer Program is US$99 per membership year, with local currency
where available. The owner completes identity verification and the payment.
Record the resulting Team ID and membership status, without exporting passwords,
session tokens or signing keys into FAKTORI's evidence records.

After membership activation, configure the actual app's bundle identifier,
capabilities, distribution certificate and provisioning profile through Xcode
and App Store Connect. Produce an archive for a physical device and TestFlight;
verify installation, secure storage, shared data and recovery on a real device.
The qualification simulator's synthetic signing prefix is not a developer team.

## Google

Start at [Play Console registration](https://support.google.com/googleplay/android-developer/answer/6112435?hl=en).
Choose the intended Google Account and personal or organization publisher type,
complete the required identity/contact verification, review the distribution
agreement and pay the US$25 one-time registration fee through Google.
New personal accounts also require real Android-device verification.

[New personal account production access](https://support.google.com/googleplay/android-developer/answer/14151465?hl=en)
requires at least 12 testers continuously opted into a closed test for at least
14 days, followed by an application for production access. This is a provider
requirement separate from FAKTORI's own qualification cohort.

After account activation, configure the real application's stable application ID,
Play App Signing and a securely retained upload key. Produce a signed Android
App Bundle and deliver through an internal track before the required closed
test. The current qualification APK's debug certificate is not the upload key.

## FAKTORI delivery gates

Keep the same accepted requirements, client/API contracts and artifact provenance
through signing. Bind the resulting distribution receipt to the actual signed
artifact, target track and developer account identity. Confirm installation and
the complete feature slice on physical devices. Store review, production access
and elapsed closed-test time cannot be replaced by local generated receipts.
Do not publish the synthetic household qualification application as a commercial
product merely to create a store receipt.
