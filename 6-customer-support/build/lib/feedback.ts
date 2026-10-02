/**
 * Ending a chat clears the chat cookie, so the conversation is kept for one hour under this name, signed the same
 * way, only so the feedback asked straight after can be filed against it.
 */
export const FEEDBACK_COOKIE = 'rp_feedback';
export const feedbackCookie = (token: string, secure: boolean) =>
  `${FEEDBACK_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/api/feedback; Max-Age=3600${secure ? '; Secure' : ''}`;
