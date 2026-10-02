/** Line icons drawn at 20px on a 1.75 stroke, so they sit at the weight of Inter 500. Decorative: callers label the control. */
type P = { size?: number };
const svg = (size: number, d: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75}
    strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{d}</svg>
);

export const PhoneIcon = ({ size = 20 }: P) => svg(size,
  <path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 6 6L15 14l5 2v3a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z" />);
export const ChatIcon = ({ size = 20 }: P) => svg(size,
  <path d="M4 5h16v11H9l-5 4z" />);
export const SendIcon = ({ size = 20 }: P) => svg(size,
  <><path d="M5 12h13" /><path d="M13 6l6 6-6 6" /></>);
export const MicIcon = ({ size = 20 }: P) => svg(size,
  <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" /></>);
export const MicOffIcon = ({ size = 20 }: P) => svg(size,
  <><path d="M15 10V6a3 3 0 0 0-5.7-1.3" /><path d="M9 9v2a3 3 0 0 0 4.6 2.5" /><path d="M5 11a7 7 0 0 0 11.5 5.3" /><path d="M19 11a7 7 0 0 1-.6 2.8" /><path d="M12 18v3" /><path d="M3 3l18 18" /></>);
export const CopyIcon = ({ size = 16 }: P) => svg(size,
  <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>);
export const CheckIcon = ({ size = 16 }: P) => svg(size, <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const ShieldIcon = ({ size = 20 }: P) => svg(size,
  <><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" /><path d="M9 12l2 2 4-4" /></>);
export const ClockIcon = ({ size = 20 }: P) => svg(size, <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>);
export const ChevronIcon = ({ size = 18, direction = 'left' }: P & { direction?: 'left' | 'right' }) =>
  svg(size, <path d={direction === 'left' ? 'M14.5 6l-6 6 6 6' : 'M9.5 6l6 6-6 6'} />);
export const UserIcon = ({ size = 20 }: P) => svg(size, <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>);
export const TicketIcon = ({ size = 20 }: P) => svg(size,
  <><path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5z" /><path d="M14 5v14" strokeDasharray="2 2.5" /></>);
export const FlagIcon = ({ size = 20 }: P) => svg(size, <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>);
export const ChecklistIcon = ({ size = 20 }: P) => svg(size,
  <><path d="M4 6.5l1.5 1.5L8 5.5" /><path d="M4 12.5l1.5 1.5L8 11.5" /><path d="M4 18.5l1.5 1.5L8 17.5" /><path d="M11 7h9M11 13h9M11 19h9" /></>);
export const SignOutIcon = ({ size = 18 }: P) => svg(size, <><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4" /><path d="M10 16l-4-4 4-4" /><path d="M6 12h10" /></>);
export const PlayIcon = ({ size = 16 }: P) => svg(size, <path d="M8 5.5v13l10-6.5z" />);
export const ChartIcon = ({ size = 20 }: P) => svg(size, <><path d="M4 20h16" /><path d="M7 16v-5" /><path d="M12 16V7" /><path d="M17 16v-8" /></>);
export const BookIcon = ({ size = 20 }: P) => svg(size, <><path d="M5 4.5h9a3 3 0 0 1 3 3V20H8a3 3 0 0 1-3-3z" /><path d="M5 17a3 3 0 0 1 3-3h9" /></>);
