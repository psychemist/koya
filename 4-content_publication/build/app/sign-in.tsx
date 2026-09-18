import ClientLogin, { Fill } from './client-login';
import ThemeToggle from './ui/theme-toggle';

/**
 * Demo accounts, read on the SERVER and rendered into the page.
 *
 * A deliberate, reversible decision rather than an oversight. This deployment
 * has to open on a reviewer's machine with nobody present, and the approval
 * gate is only meaningful if they can stand on both sides of it. Printing the
 * seeded credentials is what makes that possible while the roles stay
 * genuinely enforced server-side.
 *
 * Reversible in one step: set SEED_PASSWORD to something else, re-run
 * `npm run seed`, and what is printed here stops working. Set
 * DEMO_ACCOUNTS=false and the block does not render at all. Nothing else in
 * the system depends on it.
 *
 * The password is not a secret being leaked: it is the default already
 * committed in scripts/seed.ts, for accounts that exist only in this demo
 * database and hold nothing but synthetic content.
 */
function demoAccounts() {
  if (process.env.DEMO_ACCOUNTS === 'false') return [];
  const password = process.env.SEED_PASSWORD || 'desk-demo-2026';
  return [
    { label: 'Admin', email: 'admin@koya.test', password,
      note: 'Start here. Switches into either account below, and back.' },
    { label: 'Manager', email: 'manager@koya.test', password,
      note: 'Raises requests. Cannot approve its own work.' },
    { label: 'Editor', email: 'editor@koya.test', password,
      note: 'Approves, sends back and rejects.' },
  ];
}

/**
 * THE SIGN-IN SCREEN IS A PAGE, NOT A FORM BOX.
 *
 * It was a 420px column in the middle of a wide window with nothing either
 * side of it, which is the shape of a screen that has not been laid out. It is
 * also the only thing a reviewer sees before deciding whether the rest is
 * worth their attention.
 *
 * So: the left panel says what the thing is, on the chrome surface, and the
 * right panel is the form, on the page ground. The split is the same one the
 * whole design rests on, the application receding so the work does not. The
 * four steps are here rather than in a paragraph because the sequence IS the
 * product; a post that one person writes and sends is not what this builds.
 *
 * Below 1024px the left panel goes and the heading it carries reappears above
 * the form, so nothing that explains the page is lost on a phone.
 */
export default function SignIn() {
  const accounts = demoAccounts();

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[1fr_minmax(0,520px)]">
      <section className="hidden flex-col justify-center border-r border-rule bg-sheet px-14 py-16 lg:flex">
        <div className="max-w-[36rem]">
          <div className="flex items-center gap-2.5">
            <span
              aria-hidden="true"
              className="grid size-7 place-items-center rounded-md bg-ink text-xs font-semibold text-on-ink"
            >
              K
            </span>
            <span className="text-sm font-medium tracking-[-0.01em] text-muted">Koya Talent</span>
          </div>

          <h1 className="mt-5 font-serif text-[46px] font-normal leading-[1.04] tracking-[-0.03em]">
            Content Desk
          </h1>
          <p className="mt-4 max-w-[34rem] text-[15px] leading-relaxed text-ink-70">
            An idea goes in. A researched article, a LinkedIn post, an X post and a newsletter
            come out. None of them reaches a channel until a person signs it off.
          </p>

          <ol className="mt-9 space-y-3.5 text-[15px] leading-relaxed text-ink-70">
            {[
              'Claude reads the sources you give it and finds the competing articles, then quarantines anything carrying prompt injection.',
              'You pick one of three angles. Nothing is written until you choose, because writing three to discard two costs three times as much.',
              'The draft is checked mechanically, judged by a different model from the one that wrote it, and revised against what the checks actually said.',
              'Somebody other than the author approves it. The record keeps a fingerprint of exactly what they were shown.',
            ].map((step, i) => (
              <li key={i} className="flex gap-3.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-sunk
                             text-xs font-semibold tabular-nums text-ink-70"
                >
                  {i + 1}
                </span>
                <span>{step}</span>
              </li>
            ))}
          </ol>

          <p className="mt-9 max-w-[34rem] text-xs leading-relaxed text-muted">
            Every figure in the draft is traced back to a source excerpt. Anything the sources do
            not carry is struck in the text where it appears and blocks approval, rather than
            being quietly filled in with something plausible.
          </p>
        </div>
      </section>

      <section className="mx-auto flex min-h-dvh w-full max-w-[26rem] flex-col justify-center gap-6 px-5 py-12 lg:min-h-0 lg:max-w-none lg:px-12">
        <div className="w-full lg:mx-auto lg:max-w-[24rem]">
          {/* The heading the left panel carries, for the widths that have no
              left panel. */}
          <div className="lg:hidden">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden="true"
                className="grid size-7 place-items-center rounded-md bg-ink text-xs font-semibold text-on-ink"
              >
                K
              </span>
              <span className="text-sm font-medium text-muted">Koya Talent</span>
            </div>
            <h1 className="mt-3 text-[28px] font-semibold leading-tight tracking-[-0.02em]">
              Content Desk
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-muted">
              An idea goes in. A researched article and three channel posts come out, and
              nothing reaches a channel until a person signs it off.
            </p>
          </div>

          <div className="sheet mt-7 p-5 lg:mt-0">
            <h2 className="text-[15px] font-semibold tracking-[-0.01em]">Sign in</h2>
            <p className="mt-1 text-xs text-muted">
              Sessions last 12 hours. Every sign-in, approval and send is recorded.
            </p>
            <div className="mt-4">
              <ClientLogin />
            </div>
          </div>

          {accounts.length > 0 && (
            <div className="sheet mt-4 p-4">
              <h3 className="text-xs font-semibold">Demo accounts</h3>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                All three are real rows and the roles are enforced on the server. Sign in as the
                admin to walk both sides of the approval gate without signing out.
              </p>
              <ul className="mt-3 space-y-1">
                {accounts.map((a) => (
                  <li key={a.email}>
                    <Fill
                      email={a.email}
                      password={a.password}
                      label={a.label}
                      note={a.note}
                    />
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="mt-6 flex justify-center">
            {/* Available signed out too: someone reading this at night should
                not have to sign in first to stop it glowing at them. */}
            <ThemeToggle />
          </div>
        </div>
      </section>
    </div>
  );
}
