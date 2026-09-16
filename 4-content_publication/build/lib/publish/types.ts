export type Channel = 'linkedin' | 'x' | 'newsletter';

export type PublishResult =
  | { ok: true; providerId: string }
  | { ok: false; code: string; retryable: boolean; blocked?: boolean };

export interface Connector {
  readonly channel: Channel;
  /** Are the credentials present? Absent -> `blocked`, never a fake `sent`. */
  available(): boolean;
  /**
   * The idempotency key is passed THROUGH to the provider wherever the
   * provider supports it. Our UNIQUE constraint stops two workers racing;
   * this stops one worker's retry landing twice after a timeout.
   */
  publish(payload: Record<string, unknown>, idempotencyKey: string): Promise<PublishResult>;
}
