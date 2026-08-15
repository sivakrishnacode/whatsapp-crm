/**
 * The themed page a hosted form sits on.
 *
 * Shared by `/f/[slug]`, `/book/[slug]` and the editor's Appearance
 * preview, so what an owner previews is literally what a visitor gets.
 * The two public routes had a copy each of this markup already, and they
 * had already drifted — one said "Powered by WaCRM", the other "Powered
 * by Converse360".
 *
 * A server component: it renders no interactivity of its own, and the
 * form inside is the client boundary.
 */

import { CalendarClock } from 'lucide-react';

import { cn } from '@/lib/utils';
import {
  FORM_SCHEME_BOOT_SCRIPT,
  formSchemeAttr,
  formThemeStyle,
  type FormTheme,
} from '@/lib/forms/theme';

export default function FormSurface({
  theme,
  name,
  description,
  /** Adds the "Book a time" eyebrow above the title. */
  booking = false,
  /**
   * Rendered inside the editor rather than as a whole page: drops the
   * full-height and page padding so it sits in a panel. Everything else
   * is identical, which is the point — an owner previewing their theme
   * must be looking at the same component a visitor gets.
   */
  preview = false,
  children,
}: {
  theme: FormTheme;
  name: string;
  description?: string | null;
  booking?: boolean;
  preview?: boolean;
  children: React.ReactNode;
}) {
  const isSystem = theme.color_scheme === 'system';
  const header = theme.header_style;

  return (
    <div
      data-form-scheme={formSchemeAttr(theme)}
      // Marks the node for the boot script to correct. Present only for
      // `system`, so an owner who picked light or dark is never overridden
      // by the visitor's OS.
      {...(isSystem && !preview ? { 'data-form-scheme-auto': '' } : {})}
      style={formThemeStyle(theme)}
      className={cn(
        'bg-background text-foreground transition-colors',
        preview ? 'py-6' : 'min-h-screen py-8 md:py-16',
      )}
    >
      {isSystem && !preview && (
        <script dangerouslySetInnerHTML={{ __html: FORM_SCHEME_BOOT_SCRIPT }} />
      )}

      <div className="mx-auto max-w-2xl px-4">
        <div
          className="overflow-hidden border border-border/80 bg-card text-card-foreground shadow-2xl shadow-slate-900/10 transition-all dark:shadow-none"
          style={{ borderRadius: 'calc(var(--form-radius) * 2)' }}
        >
          {header !== 'none' && (
            <FormHeader
              style={header}
              name={name}
              description={description}
              booking={booking}
            />
          )}

          <div className="px-6 py-8 sm:px-10">
            {header === 'none' && (
              // With no banner the form still needs to say what it is.
              <div className="mb-6">
                <h1 className="text-2xl font-bold tracking-tight text-foreground">
                  {name}
                </h1>
                {description && (
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {description}
                  </p>
                )}
              </div>
            )}
            {children}
          </div>
        </div>

        {!theme.hide_branding && (
          <p className="mt-8 text-center text-xs font-medium text-muted-foreground/70">
            Powered by{' '}
            <span className="font-semibold text-foreground/80">Converse360</span>
          </p>
        )}
      </div>
    </div>
  );
}

function FormHeader({
  style,
  name,
  description,
  booking,
}: {
  style: FormTheme['header_style'];
  name: string;
  description?: string | null;
  booking: boolean;
}) {
  // `bar` is a thin accent rule over a plain card rather than a filled
  // banner — the option for a form that has to sit inside someone else's
  // brand without shouting.
  if (style === 'bar') {
    return (
      <>
        <div className="h-1.5 w-full bg-[var(--form-accent)]" />
        <div className="px-8 pt-8 pb-2">
          {booking && <Eyebrow muted />}
          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
            {name}
          </h1>
          {description && (
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground md:text-base">
              {description}
            </p>
          )}
        </div>
      </>
    );
  }

  return (
    <div
      className={cn(
        'px-8 py-10 shadow-inner',
        style === 'gradient' && 'bg-[image:var(--form-header-gradient)]',
      )}
      style={{
        color: 'var(--form-accent-fg)',
        ...(style === 'gradient'
          ? {
              // A single-hue gradient derived from the accent, so any
              // colour produces a coherent banner instead of only the
              // hardcoded violet→indigo→purple one.
              backgroundImage: `linear-gradient(110deg, var(--form-accent), color-mix(in oklab, var(--form-accent) 62%, #000))`,
            }
          : { backgroundColor: 'var(--form-accent)' }),
      }}
    >
      {booking && <Eyebrow />}
      <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{name}</h1>
      {description && (
        <p className="mt-2 text-sm leading-relaxed opacity-85 md:text-base">
          {description}
        </p>
      )}
    </div>
  );
}

function Eyebrow({ muted = false }: { muted?: boolean }) {
  return (
    <div
      className={cn(
        'mb-3 flex items-center gap-2',
        muted ? 'text-muted-foreground' : 'opacity-85',
      )}
    >
      <CalendarClock className="h-4 w-4" />
      <span className="text-xs font-medium tracking-wide uppercase">
        Book a time
      </span>
    </div>
  );
}
