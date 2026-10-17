# Bounce report (DSN) fixtures for dsn.test.ts

`sisimai-*.eml` are real bounce e-mails from the Sisimai project's test corpus
(<https://github.com/sisimai/set-of-emails>, `maildir/bsd/`; personal data
replaced by the project with example names and documentation IPs). They cover
the mail servers customers use (Postfix in front of Gmail, Microsoft 365 /
Outlook, Exchange) and the cases the reader must tell apart: unknown user,
domain without mail server, full mailbox, DMARC / spam refusals, sender-side
refusals, rate limits, delays, and an old plain-text bounce without a
delivery-status part.

`synthetic-*.eml` are **synthetic**: written for these tests, not captured.
No real bounce report from the production mailbox (parts@labparts.nl, TransIP)
was available, and which software writes TransIP's bounce reports is not
known. They cover the common shapes, each about an e-mail the site composed
(nodemailer headers, From parts@labparts.nl) so the Message-ID match is exercised:

- `synthetic-postfix-style-gmail-5.1.1.eml`: Postfix-style report ("Undelivered
  Mail Returned to Sender", full message returned) for a verification code that
  Gmail refused with its real 5.1.1 wording;
- `synthetic-exim-style-5.1.1.eml`: Exim-style report ("Mail delivery failed",
  generic `Status: 5.0.0` wrapping the remote 550 5.1.1, headers returned as
  text/rfc822-headers);
- `synthetic-plain-text-bounce.eml`: a bounce with only a text/plain part (no
  delivery-status), which the reader must leave alone.

**To do:** export one real bounce report from the parts@labparts.nl mailbox
(anonymise the recipient), add it here and assert on it like the synthetic ones.

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
