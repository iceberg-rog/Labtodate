# Bounce report (DSN) fixtures for dsn.test.ts

`sisimai-*.eml` are real bounce e-mails from the Sisimai project's test corpus
(<https://github.com/sisimai/set-of-emails>, `maildir/bsd/`; personal data
replaced by the project with example names and documentation IPs). They cover
the mail servers customers use (Postfix in front of Gmail, Microsoft 365 /
Outlook, Exchange) and the cases the reader must tell apart: unknown user,
domain without mail server, full mailbox, DMARC / spam refusals, sender-side
refusals, rate limits, delays, and an old plain-text bounce without a
delivery-status part.

`transip-postfix-gmail-5.1.1.eml` follows what TransIP sends to the sending
mailbox: Postfix's bounce ("Undelivered Mail Returned to Sender", from
MAILER-DAEMON, `X-Postfix-Sender: rfc822; parts@labparts.nl`) for a
verification-code e-mail composed by nodemailer, refused by Gmail with its
real 5.1.1 wording. It was rebuilt from Postfix's template and the headers
smtp.transip.email presents (EHLO checked 2026-10-17), not captured from the
production mailbox: replace it with a real one (anonymised) when one is at hand.

The Sisimai corpus is distributed under this licence:

```
Copyright (C) 2014, azumakuniyuki
All rights reserved.

Redistribution and use in source and binary forms, with or without modification,
are permitted provided that the following conditions are met:

 1. Redistributions of source code must retain the above copyright notice,
    this list of conditions and the following disclaimer.

 2. Redistributions in binary form must reproduce the above copyright notice,
    this list of conditions and the following disclaimer in the documentation
    and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED  BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES,  INCLUDING,  BUT NOT LIMITED TO,  THE IMPLIED
WARRANTIES  OF  MERCHANTABILITY  AND  FITNESS  FOR  A  PARTICULAR   PURPOSE  ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR
ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (
INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS
OF USE, DATA, OR PROFITS;  OR BUSINESS INTERRUPTION)  HOWEVER CAUSED  AND ON ANY
THEORY OF LIABILITY,  WHETHER IN CONTRACT,  STRICT LIABILITY, OR TORT (INCLUDING
NEGLIGENCE OR  OTHERWISE)  ARISING IN ANY WAY OUT OF THE USE  OF THIS SOFTWARE,
EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```
