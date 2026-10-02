export type BookingOutcome = 'booked' | 'slot_taken' | 'no_slot' | 'booking_failed';

/** What the support team is told about one escalation, on every channel. */
export type Alert = { ref: string; category: string; reason: string; userName: string; userEmail: string;
  requestedSlot: string | null; consoleUrl: string; outcome: BookingOutcome };

const utc = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;

/** One line, shared by Discord and email so the two channels never disagree about the booking. */
export function callbackLine(a: Alert): string {
  switch (a.outcome) {
    case 'booked': return `Callback booked for ${utc(a.requestedSlot!)}.`;
    case 'slot_taken': return `The requested time (${utc(a.requestedSlot!)}) was taken, so no callback is booked. The customer was offered other times.`;
    case 'no_slot': return 'No callback time was given. Please contact the customer to arrange one.';
    case 'booking_failed': return 'The calendar booking failed, so no callback is booked. Please contact the customer to arrange a time.';
  }
}
