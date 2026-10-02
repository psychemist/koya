-- One booked callback per time slot, across every customer. Cal.com checks free/busy, but two bookings racing
-- for the same slot, or a calendar that allows more than one, could still leave two open cases holding one time.
-- This index makes the database refuse the second; the booking step treats that refusal as the slot being taken
-- and cancels the Cal.com booking it just made. Eval dry runs are booking_status 'dry_run', so they never collide.
create unique index if not exists escalations_one_booking_per_slot
  on public.escalations (appointment_at)
  where call_booked and booking_status = 'booked' and status <> 'closed';
