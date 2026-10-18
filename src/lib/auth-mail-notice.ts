/**
 * The "check your e-mail" wording of the sign-in, sign-up and forgot-password
 * screens. The e-mail guard sends one sign-in link, code or reset link per
 * address per MAIL_ADDRESS_COOLDOWN_SEC (Settings → Security) and answers a
 * request inside that wait like a sent one, so the screens can't tell anyone
 * which addresses have an account. "We just sent it" was then false; these
 * texts say what is true either way. Pure (client-safe); the remembered
 * request times live in this tab only.
 */

/** "a minute", "90 seconds", "5 minutes". */
export function waitText(sec: number): string {
  if (sec === 60) return 'a minute';
  if (sec < 120) return `${sec} seconds`;
  if (sec % 3600 === 0) return sec === 3600 ? 'an hour' : `${sec / 3600} hours`;
  return `${Math.ceil(sec / 60)} minutes`;
}

/** "every minute", "every 90 seconds". */
function everyText(sec: number): string {
  return sec === 60 ? 'every minute' : sec === 3600 ? 'every hour' : `every ${waitText(sec)}`;
}

/**
 * The cooldown sentence under "check your e-mail". `sinceLastSec`: how long
 * ago this browser asked for an e-mail to the same address (null = not known),
 * so a second request inside the wait gets the exact time left. `kind`
 * 'code': the sign-up code screen, where an earlier code keeps working
 * (src/lib/auth.ts makes no new code inside the wait).
 */
export function mailCooldownNotice(cooldownSec: number, sinceLastSec: number | null, kind: 'link' | 'code' = 'link'): string | null {
  if (!(cooldownSec > 0)) return null;
  const retry = kind === 'code' ? 'ask for a new code' : 'try again';
  if (sinceLastSec !== null && sinceLastSec >= 0 && sinceLastSec < cooldownSec) {
    const left = Math.max(1, Math.ceil(cooldownSec - sinceLastSec));
    const use = kind === 'code' ? 'the code from your first request still works' : 'use the one from your first request';
    return `You asked for an e-mail to this address ${Math.max(1, Math.floor(sinceLastSec))} s ago, and we send at most one ${everyText(cooldownSec)}, so no new e-mail was sent: ${use}, or ${retry} in ${left} s.`;
  }
  const use = kind === 'code' ? 'use that e-mail (a code in it still works)' : 'check that e-mail';
  return `Asked for a sign-in link, code or reset link for this address less than ${waitText(cooldownSec)} ago? Then no new e-mail was sent: ${use}, or ${retry} in ${cooldownSec} s.`;
}

const lastRequest = new Map<string, number>();
const norm = (email: string) => email.trim().toLowerCase();

/** Seconds since this tab last asked for an e-mail to `email` (null: not in this tab). */
export function secondsSinceMailRequest(email: string, now = Date.now()): number | null {
  const at = lastRequest.get(norm(email));
  return at === undefined ? null : (now - at) / 1000;
}

/**
 * Remember a request that may have sent an e-mail. Returns the seconds since
 * the previous one to the same address (null when there was none), read
 * before this one is recorded. A request inside the wait does not restart it
 * (the guard counts only e-mails it sent).
 */
export function noteMailRequest(email: string, cooldownSec: number, now = Date.now()): number | null {
  const since = secondsSinceMailRequest(email, now);
  if (since === null || since >= cooldownSec) lastRequest.set(norm(email), now);
  return since;
}
